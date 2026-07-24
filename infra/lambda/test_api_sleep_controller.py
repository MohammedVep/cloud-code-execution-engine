from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


TEST_API_KEY = "tenant-test-key"
NOW_NS = 1_000_000_000_000

os.environ.update(
    {
        "API_KEY_SHA256_HASHES_JSON": json.dumps(
            [hashlib.sha256(TEST_API_KEY.encode()).hexdigest()]
        ),
        "API_SERVICE": "ccee-api",
        "WORKER_SERVICE": "ccee-worker",
        "ECS_CLUSTER": "ccee-cluster",
        "IDLE_TIMEOUT_SECONDS": "900",
        "LAST_WAKE_PARAMETER": "/ccee/api-sleep/last-wake-ns",
        "REDIS_URL_PARAMETER": "/ccee/runtime/redis-url",
        "QUEUE_METRIC_NAMESPACE": "CCEE",
        "QUEUE_METRIC_SERVICE": "ccee-worker",
        "QUEUE_NAME": "code-jobs",
        "QUEUE_SCALE_METRIC_NAME": "PendingJobsScaleSignal",
        "CACHE_HIBERNATION_ENABLED": "true",
        "CACHE_REPLICATION_GROUP_ID": "ccee-redis",
        "CACHE_DESCRIPTION": "CCEE cache",
        "CACHE_ENGINE": "valkey",
        "CACHE_ENGINE_VERSION": "7.2",
        "CACHE_NODE_TYPE": "cache.t4g.micro",
        "CACHE_PARAMETER_GROUP": "default.valkey7",
        "CACHE_NUM_CLUSTERS": "1",
        "CACHE_SUBNET_GROUP": "ccee-cache-subnets",
        "CACHE_SECURITY_GROUP_IDS_JSON": json.dumps(["sg-cache"]),
        "CACHE_PORT": "6379",
        "CACHE_AT_REST_ENCRYPTION": "true",
        "CACHE_AUTO_MINOR_VERSION_UPGRADE": "true",
        "CACHE_TRANSIT_ENCRYPTION": "true",
        "CACHE_AUTOMATIC_FAILOVER": "false",
        "CACHE_MULTI_AZ": "false",
        "CACHE_SNAPSHOT_PREFIX": "ccee-sleep",
        "CACHE_SNAPSHOT_RETENTION": "3",
        "CACHE_QUIESCENCE_SECONDS": "60",
        "CACHE_TAGS_JSON": json.dumps(
            {"Project": "ccee", "ManagedBy": "terraform"}
        ),
        "CACHE_STATE_TABLE": "ccee-sleep-state",
        "CACHE_STATE_KEY": "cache",
    }
)


class AwsError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeDynamoDB:
    def __init__(self) -> None:
        self.item: dict | None = None
        self.put_calls: list[dict] = []
        self.force_conflict = False

    def get_item(self, **_kwargs):
        return {"Item": copy.deepcopy(self.item)} if self.item else {}

    def put_item(self, **kwargs):
        self.put_calls.append(copy.deepcopy(kwargs))
        if self.force_conflict:
            raise AwsError("ConditionalCheckFailedException")
        condition = kwargs["ConditionExpression"]
        if condition.startswith("attribute_not_exists"):
            if self.item is not None:
                raise AwsError("ConditionalCheckFailedException")
        else:
            expected = kwargs["ExpressionAttributeValues"][":expected"]["N"]
            if self.item is None or self.item["revision"]["N"] != expected:
                raise AwsError("ConditionalCheckFailedException")
        self.item = copy.deepcopy(kwargs["Item"])
        return {}


class FakeSSM:
    def __init__(self, log: list[str]) -> None:
        self.log = log
        self.parameters = {
            "/ccee/api-sleep/last-wake-ns": "0",
            "/ccee/runtime/redis-url": "rediss://:secret@old.cache:6379/0",
        }

    def get_parameter(self, **kwargs):
        return {"Parameter": {"Value": self.parameters[kwargs["Name"]]}}

    def put_parameter(self, **kwargs):
        self.log.append(f"ssm:{kwargs['Name']}")
        self.parameters[kwargs["Name"]] = kwargs["Value"]
        return {"Version": 2}


def service(name: str, desired: int = 0, running: int = 0, pending: int = 0):
    return {
        "serviceName": name,
        "desiredCount": desired,
        "runningCount": running,
        "pendingCount": pending,
    }


class FakeECS:
    def __init__(self, log: list[str]) -> None:
        self.log = log
        self.describe_service_calls: list[list[str]] = []
        self.services = {
            "ccee-api": service("ccee-api"),
            "ccee-worker": service("ccee-worker"),
        }
        self.tasks: list[dict] = []
        self.list_error: Exception | None = None

    def describe_services(self, **kwargs):
        names = list(kwargs["services"])
        self.describe_service_calls.append(names)
        return {
            "services": [copy.deepcopy(self.services[name]) for name in names]
        }

    def update_service(self, **kwargs):
        self.log.append(f"ecs:update:{kwargs['desiredCount']}")
        current = self.services[kwargs["service"]]
        current["desiredCount"] = kwargs["desiredCount"]
        return {"service": copy.deepcopy(current)}

    def list_tasks(self, **kwargs):
        if self.list_error:
            raise self.list_error
        desired = kwargs["desiredStatus"]
        return {
            "taskArns": [
                task["taskArn"]
                for task in self.tasks
                if task.get("desiredStatus", "RUNNING") == desired
            ]
        }

    def describe_tasks(self, **kwargs):
        arns = set(kwargs["tasks"])
        return {
            "tasks": [copy.deepcopy(task) for task in self.tasks if task["taskArn"] in arns]
        }


class FakeCloudWatch:
    def __init__(self) -> None:
        self.datapoints: list[dict] = [{"Maximum": 0.0}]
        self.calls = 0

    def get_metric_statistics(self, **_kwargs):
        self.calls += 1
        return {"Datapoints": copy.deepcopy(self.datapoints)}


def available_group(status: str = "available") -> dict:
    return {
        "ReplicationGroupId": "ccee-redis",
        "Status": status,
        "NodeGroups": [
            {
                "PrimaryEndpoint": {"Address": "new.cache", "Port": 6379},
                "NodeGroupMembers": [
                    {
                        "CacheClusterId": "ccee-redis-001",
                        "CurrentRole": "primary",
                    }
                ],
            }
        ],
    }


class FakeElastiCache:
    def __init__(self, log: list[str]) -> None:
        self.log = log
        self.group: dict | None = available_group()
        self.snapshots: dict[str, dict] = {}
        self.created_group_args: dict | None = None
        self.created_snapshot_args: dict | None = None
        self.deleted_group = False
        self.deleted_snapshots: list[str] = []

    def describe_replication_groups(self, **_kwargs):
        if self.group is None:
            raise AwsError("ReplicationGroupNotFoundFault")
        return {"ReplicationGroups": [copy.deepcopy(self.group)]}

    def describe_snapshots(self, **kwargs):
        if "SnapshotName" in kwargs:
            snapshot = self.snapshots.get(kwargs["SnapshotName"])
            if not snapshot:
                raise AwsError("SnapshotNotFoundFault")
            return {"Snapshots": [copy.deepcopy(snapshot)]}
        return {"Snapshots": [copy.deepcopy(value) for value in self.snapshots.values()]}

    def create_snapshot(self, **kwargs):
        self.log.append("elasticache:create_snapshot")
        self.created_snapshot_args = copy.deepcopy(kwargs)
        self.snapshots[kwargs["SnapshotName"]] = {
            "SnapshotName": kwargs["SnapshotName"],
            "SnapshotStatus": "creating",
            "NodeSnapshots": [],
        }
        return {}

    def delete_replication_group(self, **_kwargs):
        self.log.append("elasticache:delete_group")
        self.deleted_group = True
        if self.group:
            self.group["Status"] = "deleting"
        return {}

    def create_replication_group(self, **kwargs):
        self.log.append("elasticache:create_group")
        self.created_group_args = copy.deepcopy(kwargs)
        self.group = available_group("creating")
        return {}

    def delete_snapshot(self, **kwargs):
        self.deleted_snapshots.append(kwargs["SnapshotName"])
        return {}


_bootstrap = {name: Mock() for name in ("ecs", "cloudwatch", "ssm", "dynamodb", "elasticache")}
_boto3 = types.ModuleType("boto3")
_boto3.client = lambda name: _bootstrap[name]
sys.modules["boto3"] = _boto3

_module_path = Path(__file__).with_name("api_sleep_controller.py")
_spec = importlib.util.spec_from_file_location("api_sleep_controller", _module_path)
assert _spec and _spec.loader
controller = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(controller)


class ApiSleepControllerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.log: list[str] = []
        self.ddb = FakeDynamoDB()
        self.ssm = FakeSSM(self.log)
        self.ecs = FakeECS(self.log)
        self.cloudwatch = FakeCloudWatch()
        self.cache = FakeElastiCache(self.log)
        controller.DYNAMODB = self.ddb
        controller.SSM = self.ssm
        controller.ECS = self.ecs
        controller.CLOUDWATCH = self.cloudwatch
        controller.ELASTICACHE = self.cache

    @staticmethod
    def wake_event(api_key: str | None = TEST_API_KEY) -> dict:
        return {
            "headers": {} if api_key is None else {"X-API-Key": api_key},
            "requestContext": {"http": {"method": "POST"}},
        }

    def seed_state(self, **updates) -> dict:
        state = {
            "_exists": False,
            "revision": 0,
            "desired": "sleep",
            "phase": controller.QUIESCING,
        }
        return controller._transition(state, **updates)

    def stale(self) -> None:
        self.ssm.parameters[controller.LAST_WAKE_PARAMETER] = "1"

    def test_rejects_invalid_key_without_aws_writes(self) -> None:
        response = controller.handle_wake(self.wake_event("wrong"))
        self.assertEqual(response["statusCode"], 401)
        self.assertEqual(self.ddb.put_calls, [])
        self.assertEqual(self.log, [])

    def test_available_cache_publishes_url_before_starting_api(self) -> None:
        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            response = controller.handle_wake(self.wake_event())

        body = json.loads(response["body"])
        self.assertEqual(response["statusCode"], 202)
        self.assertEqual(body["cachePhase"], controller.API_STARTING)
        self.assertEqual(
            self.ssm.parameters[controller.REDIS_URL_PARAMETER],
            "rediss://:secret@new.cache:6379/0",
        )
        redis_write = self.log.index(f"ssm:{controller.REDIS_URL_PARAMETER}")
        ecs_start = self.log.index("ecs:update:1")
        self.assertLess(redis_write, ecs_start)

    def test_absent_cache_restores_only_from_available_snapshot(self) -> None:
        self.cache.group = None
        self.cache.snapshots["ccee-sleep-20260101000000-000001"] = {
            "SnapshotName": "ccee-sleep-20260101000000-000001",
            "SnapshotStatus": "available",
            "NodeSnapshots": [{"SnapshotCreateTime": "2026-01-01"}],
        }
        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            response = controller.handle_wake(self.wake_event())

        self.assertEqual(response["statusCode"], 202)
        args = self.cache.created_group_args
        self.assertIsNotNone(args)
        self.assertEqual(args["SnapshotName"], "ccee-sleep-20260101000000-000001")
        self.assertEqual(args["AuthToken"], "secret")
        self.assertTrue(args["AutoMinorVersionUpgrade"])
        self.assertNotIn("TransitEncryptionMode", args)
        self.assertNotIn("AutomaticFailoverEnabled", args)
        self.assertNotIn("ecs:update:1", self.log)

    def test_absent_cache_without_snapshot_never_creates_blank_group(self) -> None:
        self.cache.group = None
        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            response = controller.handle_wake(self.wake_event())
        self.assertEqual(response["statusCode"], 500)
        self.assertIsNone(self.cache.created_group_args)

    def test_wake_waits_while_cache_is_creating(self) -> None:
        self.cache.group = available_group("creating")
        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            response = controller.handle_wake(self.wake_event())
        self.assertEqual(response["statusCode"], 202)
        self.assertEqual(json.loads(response["body"])["cachePhase"], controller.RESTORING)
        self.assertNotIn("ecs:update:1", self.log)

    def test_missing_queue_datapoint_blocks_sleep(self) -> None:
        self.stale()
        self.cloudwatch.datapoints = []
        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            result = controller.handle_idle_check()
        self.assertEqual(result["reason"], "queue_metric_missing")
        self.assertIsNone(self.cache.created_snapshot_args)

    def test_already_sleeping_skips_queue_and_task_observation(self) -> None:
        self.stale()
        snapshot_name = "ccee-sleep-protected"
        self.seed_state(
            desired="sleep",
            phase=controller.SLEEPING,
            snapshotName=snapshot_name,
        )
        self.cache.group = None
        self.cache.snapshots[snapshot_name] = {
            "SnapshotName": snapshot_name,
            "SnapshotStatus": "available",
            "NodeSnapshots": [{"SnapshotCreateTime": "2026-01-01"}],
        }
        self.cloudwatch.datapoints = []
        self.ecs.list_error = RuntimeError("task observation should not run")

        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            result = controller.handle_idle_check()

        self.assertEqual(
            result,
            {"action": "already_asleep", "cachePhase": controller.SLEEPING},
        )
        self.assertEqual(
            self.ecs.describe_service_calls,
            [[controller.API_SERVICE, controller.WORKER_SERVICE]],
        )
        self.assertEqual(self.cloudwatch.calls, 0)

    def test_already_sleeping_reports_managed_service_drift_without_scans(self) -> None:
        self.stale()
        snapshot_name = "ccee-sleep-protected"
        self.seed_state(
            desired="sleep",
            phase=controller.SLEEPING,
            snapshotName=snapshot_name,
        )
        self.cache.group = None
        self.cache.snapshots[snapshot_name] = {
            "SnapshotName": snapshot_name,
            "SnapshotStatus": "available",
            "NodeSnapshots": [{"SnapshotCreateTime": "2026-01-01"}],
        }
        self.ecs.services[controller.API_SERVICE] = service(
            controller.API_SERVICE, desired=1
        )
        self.ecs.services[controller.WORKER_SERVICE] = service(
            controller.WORKER_SERVICE, pending=1
        )
        self.cloudwatch.datapoints = []
        self.ecs.list_error = RuntimeError("task observation should not run")

        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            result = controller.handle_idle_check()

        self.assertEqual(result["action"], "kept_awake")
        self.assertEqual(result["reason"], "managed_service_drift")
        self.assertEqual(
            result["services"],
            {
                controller.API_SERVICE: {
                    "desiredCount": 1,
                    "runningCount": 0,
                    "pendingCount": 0,
                },
                controller.WORKER_SERVICE: {
                    "desiredCount": 0,
                    "runningCount": 0,
                    "pendingCount": 1,
                },
            },
        )
        self.assertEqual(self.cloudwatch.calls, 0)
        self.assertEqual(
            self.ecs.describe_service_calls,
            [[controller.API_SERVICE, controller.WORKER_SERVICE]],
        )

    def test_snapshot_progress_uses_persisted_zero_proof_after_metric_expires(self) -> None:
        self.stale()
        self.seed_state(
            phase=controller.SNAPSHOTTING,
            snapshotName="ccee-sleep-creating",
            quiescentSinceNs=NOW_NS - 120_000_000_000,
        )
        self.cache.snapshots["ccee-sleep-creating"] = {
            "SnapshotName": "ccee-sleep-creating",
            "SnapshotStatus": "creating",
        }
        self.cloudwatch.datapoints = []

        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            result = controller.handle_idle_check()

        self.assertEqual(result["action"], "snapshotting")
        self.assertEqual(self.ddb.item["phase"]["S"], controller.SNAPSHOTTING)
        self.assertIn("quiescentSinceNs", self.ddb.item)

    def test_snapshot_ready_can_delete_after_metric_expires_with_proof(self) -> None:
        self.stale()
        self.seed_state(
            phase=controller.SNAPSHOT_READY,
            snapshotName="ccee-sleep-ready-proof",
            quiescentSinceNs=NOW_NS - 120_000_000_000,
        )
        self.cache.snapshots["ccee-sleep-ready-proof"] = {
            "SnapshotName": "ccee-sleep-ready-proof",
            "SnapshotStatus": "available",
        }
        self.cloudwatch.datapoints = []

        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            result = controller.handle_idle_check()

        self.assertEqual(result["action"], "deleting_cache")
        self.assertTrue(self.cache.deleted_group)

    def test_standalone_pending_and_stopping_tasks_block_sleep(self) -> None:
        self.stale()
        for desired, last in (("RUNNING", "PENDING"), ("STOPPED", "STOPPING")):
            with self.subTest(last=last):
                self.ecs.tasks = [
                    {
                        "taskArn": f"arn:{last}",
                        "desiredStatus": desired,
                        "lastStatus": last,
                        "group": "family:ccee-runner",
                    }
                ]
                with patch.object(controller.time, "time_ns", return_value=NOW_NS):
                    result = controller.handle_idle_check()
                self.assertEqual(result["reason"], "standalone_tasks_active")
                self.assertIsNone(self.cache.created_snapshot_args)

    def test_task_observation_error_fails_open(self) -> None:
        self.stale()
        self.ecs.list_error = RuntimeError("ECS unavailable")
        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            result = controller.handle_idle_check()
        self.assertEqual(result["reason"], "dependency_error")
        self.assertIsNone(self.cache.created_snapshot_args)

    def test_sleep_scales_api_down_before_starting_quiescence_clock(self) -> None:
        self.stale()
        self.ecs.services["ccee-api"] = service("ccee-api", 1, 1)
        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            result = controller.handle_idle_check()
        self.assertEqual(result["action"], "quiescing")
        self.assertEqual(self.log.count("ecs:update:0"), 1)
        self.assertIsNone(self.cache.created_snapshot_args)

    def test_requires_two_clear_checks_then_snapshots_primary_member(self) -> None:
        self.stale()
        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            first = controller.handle_idle_check()
        self.assertEqual(first["action"], "quiescence_started")
        self.assertIsNone(self.cache.created_snapshot_args)

        with patch.object(
            controller.time,
            "time_ns",
            return_value=NOW_NS + 61_000_000_000,
        ):
            second = controller.handle_idle_check()
        self.assertEqual(second["action"], "snapshotting")
        self.assertEqual(
            self.cache.created_snapshot_args["CacheClusterId"], "ccee-redis-001"
        )
        self.assertNotIn("ReplicationGroupId", self.cache.created_snapshot_args)

    def test_ambiguous_primary_fails_open_without_snapshot(self) -> None:
        self.stale()
        state = self.seed_state(
            quiescentSinceNs=NOW_NS - 61_000_000_000,
        )
        self.cache.group["NodeGroups"][0]["NodeGroupMembers"].append(
            {"CacheClusterId": "ccee-redis-002", "CurrentRole": "primary"}
        )
        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            result = controller.handle_idle_check()
        self.assertEqual(result["reason"], "dependency_error")
        self.assertIsNone(self.cache.created_snapshot_args)
        self.assertEqual(state["phase"], controller.QUIESCING)

    def test_activity_after_snapshot_started_invalidates_protected_pointer(self) -> None:
        self.stale()
        self.seed_state(
            phase=controller.SNAPSHOTTING,
            snapshotName="ccee-sleep-old",
            quiescentSinceNs=NOW_NS - 120_000_000_000,
        )
        self.cache.snapshots["ccee-sleep-old"] = {
            "SnapshotName": "ccee-sleep-old",
            "SnapshotStatus": "available",
        }
        self.cloudwatch.datapoints = [{"Maximum": 1.0}]
        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            result = controller.handle_idle_check()
        self.assertEqual(result["reason"], "queue_active")
        self.assertEqual(self.ddb.item["phase"]["S"], controller.QUIESCING)
        self.assertNotIn("snapshotName", self.ddb.item)
        self.assertFalse(self.cache.deleted_group)

    def test_snapshot_ready_requires_another_clear_check_before_delete(self) -> None:
        self.stale()
        self.seed_state(
            phase=controller.SNAPSHOTTING,
            snapshotName="ccee-sleep-ready",
        )
        self.cache.snapshots["ccee-sleep-ready"] = {
            "SnapshotName": "ccee-sleep-ready",
            "SnapshotStatus": "available",
        }
        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            first = controller.handle_idle_check()
        self.assertEqual(first["action"], "snapshot_ready")
        self.assertFalse(self.cache.deleted_group)

        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            second = controller.handle_idle_check()
        self.assertEqual(second["action"], "deleting_cache")
        self.assertTrue(self.cache.deleted_group)

    def test_deleting_state_with_available_group_takes_fresh_snapshot(self) -> None:
        self.stale()
        old_snapshot = "ccee-sleep-20260101000000-000001"
        self.seed_state(
            phase=controller.DELETING,
            snapshotName=old_snapshot,
            quiescentSinceNs=NOW_NS - 120_000_000_000,
        )
        self.cache.snapshots[old_snapshot] = {
            "SnapshotName": old_snapshot,
            "SnapshotStatus": "available",
        }
        self.cloudwatch.datapoints = []

        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            result = controller.handle_idle_check()

        self.assertEqual(result["action"], "snapshotting")
        self.assertEqual(self.ddb.item["phase"]["S"], controller.SNAPSHOTTING)
        self.assertNotEqual(self.ddb.item["snapshotName"]["S"], old_snapshot)
        self.assertIsNotNone(self.cache.created_snapshot_args)
        self.assertFalse(self.cache.deleted_group)

    def test_wake_during_delete_restores_once_group_is_absent(self) -> None:
        snapshot_name = "ccee-sleep-protected"
        self.seed_state(
            phase=controller.DELETING,
            snapshotName=snapshot_name,
        )
        self.cache.snapshots[snapshot_name] = {
            "SnapshotName": snapshot_name,
            "SnapshotStatus": "available",
            "NodeSnapshots": [{"SnapshotCreateTime": "2026-01-01"}],
        }
        self.cache.group = available_group("deleting")

        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            response = controller.handle_wake(self.wake_event())
        self.assertEqual(response["statusCode"], 202)
        self.assertEqual(json.loads(response["body"])["cachePhase"], controller.DELETING)
        self.assertIsNone(self.cache.created_group_args)

        self.cache.group = None
        with patch.object(controller.time, "time_ns", return_value=NOW_NS + 1):
            result = controller.handle_idle_check()
        self.assertEqual(result["cachePhase"], controller.RESTORING)
        self.assertEqual(self.cache.created_group_args["SnapshotName"], snapshot_name)
        self.assertNotIn("ecs:update:1", self.log)

    def test_controller_snapshot_name_matcher_is_exact(self) -> None:
        generated_name = controller._new_snapshot_name(NOW_NS + 258_830)
        self.assertTrue(controller._is_controller_snapshot_name(generated_name))
        self.assertLessEqual(len(generated_name), 40)

        for name in (
            "ccee-sleep-migration-20260712-0045",
            "ccee-sleep-operator-20260101000000-000001",
            "ccee-sleep-20260101000000-000001-extra",
            "ccee-sleep-20260101000000-operator",
            "ccee-sleep-2026010100000-000001",
            "foreign-sleep-20260101000000-000001",
        ):
            with self.subTest(name=name):
                self.assertFalse(controller._is_controller_snapshot_name(name))

    def test_snapshot_pruning_keeps_newest_and_protected(self) -> None:
        controller_names: list[str] = []
        for number in range(1, 6):
            name = f"ccee-sleep-2026010100000{number}-00000{number}"
            controller_names.append(name)
            self.cache.snapshots[name] = {
                "SnapshotName": name,
                "SnapshotStatus": "available",
                "NodeSnapshots": [{"SnapshotCreateTime": f"2026-01-0{number}"}],
            }
        creating_name = "ccee-sleep-20260106000000-000006"
        self.cache.snapshots[creating_name] = {
            "SnapshotName": creating_name,
            "SnapshotStatus": "creating",
            "NodeSnapshots": [{"SnapshotCreateTime": "2025-01-01"}],
        }
        non_controller_names = (
            "ccee-sleep-migration-20260712-0045",
            "ccee-sleep-operator-backup",
            "ccee-sleep-20260101000000-000001-extra",
            "foreign-snapshot",
        )
        for name in non_controller_names:
            self.cache.snapshots[name] = {
                "SnapshotName": name,
                "SnapshotStatus": "available",
                "NodeSnapshots": [{"SnapshotCreateTime": "2024-01-01"}],
            }

        controller._prune_snapshots(controller_names[0])

        self.assertEqual(self.cache.deleted_snapshots, [controller_names[1]])
        self.assertNotIn(creating_name, self.cache.deleted_snapshots)
        for name in non_controller_names:
            self.assertNotIn(name, self.cache.deleted_snapshots)

    def test_state_conflict_prevents_external_mutation(self) -> None:
        self.ddb.force_conflict = True
        with patch.object(controller.time, "time_ns", return_value=NOW_NS):
            response = controller.handle_wake(self.wake_event())
        self.assertEqual(response["statusCode"], 409)
        self.assertNotIn("ecs:update:1", self.log)
        self.assertIsNone(self.cache.created_group_args)


if __name__ == "__main__":
    unittest.main()
