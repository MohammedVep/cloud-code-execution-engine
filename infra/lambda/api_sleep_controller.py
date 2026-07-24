"""Authenticated wake and conservative cache-hibernation controller for CCEE.

The Lambda has two entry points: API Gateway invokes it for ``POST /wake`` and
EventBridge invokes it with ``{"action":"idle_check"}``.  Destructive cache
operations are split across invocations and are fenced by a revisioned DynamoDB
state item.  Observation failures always delay sleep; they never authorize a
snapshot or deletion.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import unquote, urlsplit, urlunsplit

import boto3


LOGGER = logging.getLogger(__name__)
LOGGER.setLevel(logging.INFO)

ECS = boto3.client("ecs")
CLOUDWATCH = boto3.client("cloudwatch")
SSM = boto3.client("ssm")
DYNAMODB = boto3.client("dynamodb")
ELASTICACHE = boto3.client("elasticache")

ECS_CLUSTER = os.environ["ECS_CLUSTER"]
API_SERVICE = os.environ["API_SERVICE"]
WORKER_SERVICE = os.environ["WORKER_SERVICE"]
LAST_WAKE_PARAMETER = os.environ["LAST_WAKE_PARAMETER"]
REDIS_URL_PARAMETER = os.environ["REDIS_URL_PARAMETER"]
IDLE_TIMEOUT_SECONDS = int(os.environ["IDLE_TIMEOUT_SECONDS"])
QUEUE_METRIC_NAMESPACE = os.environ["QUEUE_METRIC_NAMESPACE"]
QUEUE_SCALE_METRIC_NAME = os.environ["QUEUE_SCALE_METRIC_NAME"]
QUEUE_NAME = os.environ["QUEUE_NAME"]
QUEUE_METRIC_SERVICE = os.environ["QUEUE_METRIC_SERVICE"]

CACHE_HIBERNATION_ENABLED = os.environ["CACHE_HIBERNATION_ENABLED"].lower() == "true"
CACHE_REPLICATION_GROUP_ID = os.environ["CACHE_REPLICATION_GROUP_ID"]
CACHE_DESCRIPTION = os.environ["CACHE_DESCRIPTION"]
CACHE_ENGINE = os.environ["CACHE_ENGINE"]
CACHE_ENGINE_VERSION = os.environ["CACHE_ENGINE_VERSION"]
CACHE_NODE_TYPE = os.environ["CACHE_NODE_TYPE"]
CACHE_PARAMETER_GROUP = os.environ["CACHE_PARAMETER_GROUP"]
CACHE_NUM_CLUSTERS = int(os.environ["CACHE_NUM_CLUSTERS"])
CACHE_SUBNET_GROUP = os.environ["CACHE_SUBNET_GROUP"]
CACHE_SECURITY_GROUP_IDS = json.loads(os.environ["CACHE_SECURITY_GROUP_IDS_JSON"])
CACHE_PORT = int(os.environ["CACHE_PORT"])
CACHE_AT_REST_ENCRYPTION = os.environ["CACHE_AT_REST_ENCRYPTION"].lower() == "true"
CACHE_AUTO_MINOR_VERSION_UPGRADE = (
    os.environ["CACHE_AUTO_MINOR_VERSION_UPGRADE"].lower() == "true"
)
CACHE_TRANSIT_ENCRYPTION = os.environ["CACHE_TRANSIT_ENCRYPTION"].lower() == "true"
CACHE_AUTOMATIC_FAILOVER = os.environ["CACHE_AUTOMATIC_FAILOVER"].lower() == "true"
CACHE_MULTI_AZ = os.environ["CACHE_MULTI_AZ"].lower() == "true"
CACHE_SNAPSHOT_PREFIX = os.environ["CACHE_SNAPSHOT_PREFIX"]
CACHE_SNAPSHOT_RETENTION = int(os.environ["CACHE_SNAPSHOT_RETENTION"])
CACHE_QUIESCENCE_SECONDS = int(os.environ.get("CACHE_QUIESCENCE_SECONDS", "60"))
CACHE_TAGS = json.loads(os.environ["CACHE_TAGS_JSON"])
CACHE_STATE_TABLE = os.environ["CACHE_STATE_TABLE"]
CACHE_STATE_KEY = os.environ["CACHE_STATE_KEY"]

ACTIVE = "ACTIVE"
QUIESCING = "QUIESCING"
SNAPSHOTTING = "SNAPSHOTTING"
SNAPSHOT_READY = "SNAPSHOT_READY"
DELETING = "DELETING"
SLEEPING = "SLEEPING"
RESTORING = "RESTORING"
API_STARTING = "API_STARTING"
ERROR = "ERROR"


class StateConflict(RuntimeError):
    """The controller item changed between its read and conditional write."""


def _load_api_key_hashes() -> tuple[str, ...]:
    raw_hashes = json.loads(os.environ["API_KEY_SHA256_HASHES_JSON"])
    if not isinstance(raw_hashes, list) or not raw_hashes:
        raise ValueError("API_KEY_SHA256_HASHES_JSON must contain at least one hash")
    hashes = tuple(
        value.lower()
        for value in raw_hashes
        if isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdefABCDEF" for character in value)
    )
    if len(hashes) != len(raw_hashes):
        raise ValueError("API_KEY_SHA256_HASHES_JSON contains an invalid SHA-256 hash")
    return hashes


API_KEY_HASHES = _load_api_key_hashes()


def _response(status_code: int, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(payload, separators=(",", ":")),
    }


def _error_code(error: Exception) -> str:
    response = getattr(error, "response", {})
    if isinstance(response, dict):
        details = response.get("Error", {})
        if isinstance(details, dict):
            return str(details.get("Code", ""))
    return type(error).__name__


def _request_api_key(event: dict[str, Any]) -> str:
    for name, value in (event.get("headers") or {}).items():
        if str(name).lower() == "x-api-key" and isinstance(value, str):
            return value
    return ""


def _is_authorized(event: dict[str, Any]) -> bool:
    api_key = _request_api_key(event)
    if not api_key:
        return False
    candidate_hash = hashlib.sha256(api_key.encode("utf-8")).hexdigest()
    return any(
        hmac.compare_digest(candidate_hash, expected_hash)
        for expected_hash in API_KEY_HASHES
    )


def _service(name: str) -> dict[str, Any]:
    result = ECS.describe_services(cluster=ECS_CLUSTER, services=[name])
    services = result.get("services") or []
    if result.get("failures") or len(services) != 1:
        raise RuntimeError(f"ECS service {name!r} could not be described")
    return services[0]


def _counts(service: dict[str, Any]) -> dict[str, int]:
    return {
        field: int(service.get(field, 0))
        for field in ("desiredCount", "runningCount", "pendingCount")
    }


def _managed_service_counts() -> dict[str, dict[str, int]]:
    names = [API_SERVICE, WORKER_SERVICE]
    result = ECS.describe_services(cluster=ECS_CLUSTER, services=names)
    services = result.get("services") or []
    by_name = {
        str(service.get("serviceName")): service
        for service in services
        if service.get("serviceName")
    }
    if result.get("failures") or set(by_name) != set(names):
        raise RuntimeError("Managed API and worker services could not be described")
    return {name: _counts(by_name[name]) for name in names}


def _is_stopped(service: dict[str, Any]) -> bool:
    return all(value == 0 for value in _counts(service).values())


def _set_api_desired_count(desired_count: int) -> dict[str, Any]:
    result = ECS.update_service(
        cluster=ECS_CLUSTER, service=API_SERVICE, desiredCount=desired_count
    )
    service = result.get("service")
    if not isinstance(service, dict):
        raise RuntimeError("ECS UpdateService returned no service")
    return service


def _write_last_wake_ns(now_ns: int) -> None:
    SSM.put_parameter(
        Name=LAST_WAKE_PARAMETER, Type="String", Value=str(now_ns), Overwrite=True
    )


def _read_last_wake_ns() -> int:
    result = SSM.get_parameter(Name=LAST_WAKE_PARAMETER)
    raw_value = result.get("Parameter", {}).get("Value")
    try:
        value = int(raw_value)
    except (TypeError, ValueError) as error:
        raise RuntimeError("Last-wake SSM parameter is not an integer") from error
    if value < 0:
        raise RuntimeError("Last-wake SSM parameter cannot be negative")
    return value


def _read_state() -> dict[str, Any]:
    result = DYNAMODB.get_item(
        TableName=CACHE_STATE_TABLE,
        Key={"controller": {"S": CACHE_STATE_KEY}},
        ConsistentRead=True,
    )
    item = result.get("Item")
    if not item:
        return {
            "_exists": False,
            "revision": 0,
            "desired": "awake",
            "phase": ACTIVE,
        }

    state: dict[str, Any] = {
        "_exists": True,
        "revision": int(item["revision"]["N"]),
        "desired": item["desired"]["S"],
        "phase": item["phase"]["S"],
    }
    for name in ("snapshotName", "errorType"):
        if name in item:
            state[name] = item[name]["S"]
    for name in ("wakeRequestedNs", "updatedAtNs", "quiescentSinceNs"):
        if name in item:
            state[name] = int(item[name]["N"])
    return state


def _transition(state: dict[str, Any], **updates: Any) -> dict[str, Any]:
    next_state = {key: value for key, value in state.items() if not key.startswith("_")}
    for key, value in updates.items():
        if value is None:
            next_state.pop(key, None)
        else:
            next_state[key] = value
    next_state["revision"] = int(state["revision"]) + 1
    next_state["updatedAtNs"] = time.time_ns()

    item: dict[str, dict[str, str]] = {
        "controller": {"S": CACHE_STATE_KEY},
        "revision": {"N": str(next_state["revision"])},
        "desired": {"S": str(next_state["desired"])},
        "phase": {"S": str(next_state["phase"])},
        "updatedAtNs": {"N": str(next_state["updatedAtNs"])},
    }
    for name in ("snapshotName", "errorType"):
        if name in next_state:
            item[name] = {"S": str(next_state[name])}
    if "wakeRequestedNs" in next_state:
        item["wakeRequestedNs"] = {"N": str(next_state["wakeRequestedNs"])}
    if "quiescentSinceNs" in next_state:
        item["quiescentSinceNs"] = {"N": str(next_state["quiescentSinceNs"])}

    arguments: dict[str, Any] = {
        "TableName": CACHE_STATE_TABLE,
        "Item": item,
        "ExpressionAttributeNames": {"#controller": "controller"},
    }
    if state.get("_exists"):
        arguments.update(
            {
                "ConditionExpression": "#revision = :expected",
                "ExpressionAttributeNames": {"#revision": "revision"},
                "ExpressionAttributeValues": {
                    ":expected": {"N": str(state["revision"])}
                },
            }
        )
    else:
        arguments["ConditionExpression"] = "attribute_not_exists(#controller)"

    try:
        DYNAMODB.put_item(**arguments)
    except Exception as error:
        if _error_code(error) == "ConditionalCheckFailedException":
            raise StateConflict("cache controller state changed") from error
        raise
    next_state["_exists"] = True
    return next_state


def _mark_error(state: dict[str, Any], error: Exception) -> None:
    try:
        _transition(
            state,
            phase=ERROR,
            quiescentSinceNs=None,
            errorType=_error_code(error) or type(error).__name__,
        )
    except Exception:
        LOGGER.exception("Failed to persist cache-controller error state")


def _metric_period_seconds(lookback_seconds: int) -> int:
    minimum_period = max(60, (lookback_seconds + 1439) // 1440)
    return ((minimum_period + 59) // 60) * 60


def _queue_scale_max(now: datetime) -> float | None:
    result = CLOUDWATCH.get_metric_statistics(
        Namespace=QUEUE_METRIC_NAMESPACE,
        MetricName=QUEUE_SCALE_METRIC_NAME,
        Dimensions=[
            {"Name": "QueueName", "Value": QUEUE_NAME},
            {"Name": "Service", "Value": QUEUE_METRIC_SERVICE},
        ],
        StartTime=now - timedelta(seconds=IDLE_TIMEOUT_SECONDS),
        EndTime=now,
        Period=_metric_period_seconds(IDLE_TIMEOUT_SECONDS),
        Statistics=["Maximum"],
    )
    datapoints = result.get("Datapoints") or []
    if not datapoints:
        return None
    return max(float(point.get("Maximum", 0)) for point in datapoints)


def _unexpected_running_tasks(*, allow_api_service: bool = True) -> list[str]:
    task_arns: dict[str, str] = {}
    # ECS desiredStatus=RUNNING includes PROVISIONING/PENDING/ACTIVATING tasks.
    # A second STOPPED query catches tasks in DEACTIVATING/STOPPING before they
    # disappear; ListTasks does not support desiredStatus=PENDING.
    for desired_status in ("RUNNING", "STOPPED"):
        token: str | None = None
        while True:
            arguments: dict[str, Any] = {
                "cluster": ECS_CLUSTER,
                "desiredStatus": desired_status,
            }
            if token:
                arguments["nextToken"] = token
            page = ECS.list_tasks(**arguments)
            for task_arn in page.get("taskArns") or []:
                task_arns[str(task_arn)] = desired_status
            token = page.get("nextToken")
            if not token:
                break

    # The API service may still be running during the first observation because
    # this controller is responsible for scaling it down. Worker service tasks
    # and, after API count reaches zero, every active task block hibernation.
    allowed_groups = {f"service:{API_SERVICE}"} if allow_api_service else set()
    unexpected: list[str] = []
    arns = list(task_arns)
    for offset in range(0, len(arns), 100):
        result = ECS.describe_tasks(
            cluster=ECS_CLUSTER, tasks=arns[offset : offset + 100]
        )
        if result.get("failures"):
            raise RuntimeError("ECS DescribeTasks reported failures")
        for task in result.get("tasks") or []:
            last_status = str(task.get("lastStatus", "")).upper()
            if last_status != "STOPPED" and (
                task_arns.get(str(task.get("taskArn"))) == "STOPPED"
                or task.get("group") not in allowed_groups
            ):
                unexpected.append(str(task.get("taskArn", "unknown")))
    return unexpected


def _replication_group() -> dict[str, Any] | None:
    try:
        result = ELASTICACHE.describe_replication_groups(
            ReplicationGroupId=CACHE_REPLICATION_GROUP_ID
        )
    except Exception as error:
        if _error_code(error) == "ReplicationGroupNotFoundFault":
            return None
        raise
    groups = result.get("ReplicationGroups") or []
    if len(groups) != 1:
        raise RuntimeError("Expected exactly one managed replication group")
    return groups[0]


def _primary_cache_cluster_id(group: dict[str, Any]) -> str:
    primary_ids = {
        str(member.get("CacheClusterId"))
        for node_group in group.get("NodeGroups") or []
        for member in node_group.get("NodeGroupMembers") or []
        if str(member.get("CurrentRole", "")).lower() == "primary"
        and member.get("CacheClusterId")
    }
    if len(primary_ids) != 1:
        raise RuntimeError("Expected exactly one primary cache cluster for snapshot")
    return next(iter(primary_ids))


def _snapshot(name: str) -> dict[str, Any] | None:
    try:
        result = ELASTICACHE.describe_snapshots(SnapshotName=name)
    except Exception as error:
        if _error_code(error) in {"SnapshotNotFoundFault", "CacheClusterNotFound"}:
            return None
        raise
    snapshots = result.get("Snapshots") or []
    if not snapshots:
        return None
    if len(snapshots) != 1:
        raise RuntimeError("Expected exactly one named cache snapshot")
    return snapshots[0]


def _controller_snapshot_prefix() -> str:
    generated_suffix = "-20000101000000-000000"
    prefix = CACHE_SNAPSHOT_PREFIX[: 40 - len(generated_suffix)].rstrip("-")
    if not prefix or not prefix[0].isalpha():
        raise RuntimeError("Cache snapshot prefix must begin with a letter")
    return prefix


def _is_controller_snapshot_name(name: str) -> bool:
    prefix = f"{_controller_snapshot_prefix()}-"
    if not name.startswith(prefix):
        return False
    timestamp, separator, nonce = name[len(prefix) :].partition("-")
    return (
        separator == "-"
        and len(timestamp) == 14
        and timestamp.isdigit()
        and len(nonce) == 6
        and nonce.isdigit()
    )


def _controller_snapshots() -> list[dict[str, Any]]:
    snapshots: list[dict[str, Any]] = []
    marker: str | None = None
    while True:
        arguments: dict[str, Any] = {"SnapshotSource": "manual"}
        if marker:
            arguments["Marker"] = marker
        page = ELASTICACHE.describe_snapshots(**arguments)
        snapshots.extend(
            snapshot
            for snapshot in page.get("Snapshots") or []
            if _is_controller_snapshot_name(str(snapshot.get("SnapshotName", "")))
        )
        marker = page.get("Marker")
        if not marker:
            return snapshots


def _snapshot_sort_key(snapshot: dict[str, Any]) -> tuple[str, str]:
    nodes = snapshot.get("NodeSnapshots") or [{}]
    created = nodes[0].get("SnapshotCreateTime", "")
    return (str(created), str(snapshot.get("SnapshotName", "")))


def _latest_available_snapshot() -> dict[str, Any] | None:
    available = [
        snapshot
        for snapshot in _controller_snapshots()
        if str(snapshot.get("SnapshotStatus", "")).lower() == "available"
    ]
    return max(available, key=_snapshot_sort_key) if available else None


def _new_snapshot_name(now_ns: int) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return f"{_controller_snapshot_prefix()}-{timestamp}-{now_ns % 1_000_000:06d}"


def _cache_endpoint(group: dict[str, Any]) -> str:
    endpoint = group.get("ConfigurationEndpoint") or {}
    if not endpoint:
        node_groups = group.get("NodeGroups") or []
        if len(node_groups) != 1:
            raise RuntimeError("Expected one cache node group endpoint")
        endpoint = node_groups[0].get("PrimaryEndpoint") or {}
    address = endpoint.get("Address")
    if not isinstance(address, str) or not address:
        raise RuntimeError("Available cache has no endpoint address")
    return address


def _read_redis_url() -> str:
    result = SSM.get_parameter(Name=REDIS_URL_PARAMETER, WithDecryption=True)
    value = result.get("Parameter", {}).get("Value")
    if not isinstance(value, str):
        raise RuntimeError("Redis URL SSM parameter is unavailable")
    parsed = urlsplit(value)
    if parsed.scheme not in {"redis", "rediss"}:
        raise RuntimeError("Redis URL SSM parameter has an unsupported scheme")
    return value


def _url_with_endpoint(value: str, endpoint: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"redis", "rediss"}:
        raise RuntimeError("Redis URL SSM parameter has an unsupported scheme")
    userinfo = parsed.netloc.rsplit("@", 1)[0] + "@" if "@" in parsed.netloc else ""
    port = parsed.port or CACHE_PORT
    return urlunsplit(
        (parsed.scheme, f"{userinfo}{endpoint}:{port}", parsed.path, parsed.query, parsed.fragment)
    )


def _publish_cache_endpoint(group: dict[str, Any]) -> None:
    current = _read_redis_url()
    replacement = _url_with_endpoint(current, _cache_endpoint(group))
    SSM.put_parameter(
        Name=REDIS_URL_PARAMETER,
        Type="SecureString",
        Value=replacement,
        Overwrite=True,
    )
    if _read_redis_url() != replacement:
        raise RuntimeError("Redis URL SSM parameter update could not be verified")


def _redis_url_matches_cache(group: dict[str, Any]) -> bool:
    parsed = urlsplit(_read_redis_url())
    return parsed.hostname == _cache_endpoint(group) and (
        parsed.port or CACHE_PORT
    ) == CACHE_PORT


def _create_replication_group(snapshot_name: str) -> None:
    redis_url = _read_redis_url()
    parsed = urlsplit(redis_url)
    arguments: dict[str, Any] = {
        "ReplicationGroupId": CACHE_REPLICATION_GROUP_ID,
        "ReplicationGroupDescription": CACHE_DESCRIPTION,
        "Engine": CACHE_ENGINE,
        "EngineVersion": CACHE_ENGINE_VERSION,
        "CacheNodeType": CACHE_NODE_TYPE,
        "CacheParameterGroupName": CACHE_PARAMETER_GROUP,
        "NumCacheClusters": CACHE_NUM_CLUSTERS,
        "CacheSubnetGroupName": CACHE_SUBNET_GROUP,
        "SecurityGroupIds": CACHE_SECURITY_GROUP_IDS,
        "Port": CACHE_PORT,
        "AtRestEncryptionEnabled": CACHE_AT_REST_ENCRYPTION,
        "AutoMinorVersionUpgrade": CACHE_AUTO_MINOR_VERSION_UPGRADE,
        "TransitEncryptionEnabled": CACHE_TRANSIT_ENCRYPTION,
        "SnapshotName": snapshot_name,
        "Tags": [{"Key": key, "Value": str(value)} for key, value in CACHE_TAGS.items()],
    }
    if parsed.password:
        arguments["AuthToken"] = unquote(parsed.password)
    if CACHE_NUM_CLUSTERS > 1:
        arguments["AutomaticFailoverEnabled"] = CACHE_AUTOMATIC_FAILOVER
        arguments["MultiAZEnabled"] = CACHE_MULTI_AZ
    ELASTICACHE.create_replication_group(**arguments)


def _prune_snapshots(protected_name: str | None) -> None:
    available = sorted(
        (
            snapshot
            for snapshot in _controller_snapshots()
            if str(snapshot.get("SnapshotStatus", "")).lower() == "available"
        ),
        key=_snapshot_sort_key,
        reverse=True,
    )
    keep = {
        str(snapshot["SnapshotName"])
        for snapshot in available[:CACHE_SNAPSHOT_RETENTION]
    }
    if protected_name:
        keep.add(protected_name)
    for snapshot in available:
        name = str(snapshot["SnapshotName"])
        if name not in keep:
            try:
                ELASTICACHE.delete_snapshot(SnapshotName=name)
            except Exception:
                LOGGER.exception("Failed to prune an old controller-owned cache snapshot")


def _wake_payload(state: dict[str, Any], service: dict[str, Any] | None = None) -> dict[str, Any]:
    running = int((service or {}).get("runningCount", 0))
    desired = int((service or {}).get("desiredCount", 0))
    status = "awake" if running > 0 and state["phase"] == ACTIVE else "waking"
    payload: dict[str, Any] = {
        "status": status,
        "cachePhase": state["phase"],
        "desiredCount": desired,
        "runningCount": running,
    }
    if status != "awake":
        payload["retryAfterSeconds"] = 10
    return payload


def _start_api_after_cache(state: dict[str, Any], group: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    _publish_cache_endpoint(group)
    if state["phase"] != API_STARTING:
        state = _transition(
            state, phase=API_STARTING, quiescentSinceNs=None, errorType=None
        )
    service = _service(API_SERVICE)
    if int(service.get("desiredCount", 0)) != 1:
        service = _set_api_desired_count(1)
    if int(service.get("runningCount", 0)) > 0:
        state = _transition(
            state,
            desired="awake",
            phase=ACTIVE,
            quiescentSinceNs=None,
            errorType=None,
        )
        try:
            _prune_snapshots(state.get("snapshotName"))
        except Exception:
            LOGGER.exception("Failed to inspect controller snapshots for pruning")
    return state, service


def _reconcile_awake(state: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    if not CACHE_HIBERNATION_ENABLED:
        service = _service(API_SERVICE)
        if int(service.get("desiredCount", 0)) != 1:
            service = _set_api_desired_count(1)
        state = _transition(
            state,
            desired="awake",
            phase=ACTIVE,
            quiescentSinceNs=None,
            errorType=None,
        )
        return (200 if int(service.get("runningCount", 0)) > 0 else 202, _wake_payload(state, service))

    group = _replication_group()
    if group is not None:
        status = str(group.get("Status", "")).lower()
        if status == "available":
            if state["phase"] == ACTIVE:
                if not _redis_url_matches_cache(group):
                    _publish_cache_endpoint(group)
                service = _service(API_SERVICE)
                if int(service.get("desiredCount", 0)) != 1:
                    service = _set_api_desired_count(1)
                return (
                    200 if int(service.get("runningCount", 0)) > 0 else 202,
                    _wake_payload(state, service),
                )
            state, service = _start_api_after_cache(state, group)
            return (200 if int(service.get("runningCount", 0)) > 0 else 202, _wake_payload(state, service))
        phase = DELETING if status == "deleting" else RESTORING
        if state["phase"] != phase:
            state = _transition(state, desired="awake", phase=phase, errorType=None)
        return 202, _wake_payload(state)

    snapshot_name = state.get("snapshotName")
    snapshot = _snapshot(snapshot_name) if snapshot_name else None
    if snapshot is None:
        snapshot = _latest_available_snapshot()
        snapshot_name = snapshot.get("SnapshotName") if snapshot else None
    if snapshot is None:
        raise RuntimeError("No controller-owned cache snapshot is available for restore")
    if str(snapshot.get("SnapshotStatus", "")).lower() != "available":
        if state["phase"] != RESTORING:
            state = _transition(
                state, desired="awake", phase=RESTORING, snapshotName=snapshot_name
            )
        return 202, _wake_payload(state)

    if state["phase"] != RESTORING or state.get("snapshotName") != snapshot_name:
        state = _transition(
            state,
            desired="awake",
            phase=RESTORING,
            snapshotName=snapshot_name,
            errorType=None,
        )
    try:
        _create_replication_group(str(snapshot_name))
    except Exception as error:
        if _error_code(error) != "ReplicationGroupAlreadyExistsFault":
            _mark_error(state, error)
            raise
    return 202, _wake_payload(state)


def handle_wake(event: dict[str, Any]) -> dict[str, Any]:
    method = event.get("requestContext", {}).get("http", {}).get("method", "POST")
    if method != "POST":
        return _response(405, {"error": "method_not_allowed"})
    if not _is_authorized(event):
        return _response(401, {"error": "unauthorized"})

    now_ns = time.time_ns()
    try:
        # A wake is not accepted unless its lease is durably recorded.
        _write_last_wake_ns(now_ns)
        state = _read_state()
        initial_phase = API_STARTING if not state.get("_exists") else state["phase"]
        state = _transition(
            state,
            desired="awake",
            phase=initial_phase,
            wakeRequestedNs=now_ns,
            quiescentSinceNs=None,
            errorType=None,
        )
        status_code, payload = _reconcile_awake(state)
        LOGGER.info(
            "Processed authenticated wake request",
            extra={"cache_phase": payload["cachePhase"]},
        )
        return _response(status_code, payload)
    except StateConflict:
        return _response(409, {"error": "wake_conflict", "retryAfterSeconds": 1})
    except Exception as error:
        LOGGER.exception("Failed to reconcile authenticated wake request")
        try:
            error_state = locals().get("state")
            if error_state is None:
                error_state = _read_state()
            _mark_error(error_state, error)
        except Exception:
            LOGGER.exception("Failed to load state while recording wake error")
        return _response(500, {"error": "wake_failed"})


def _kept_awake(reason: str, **details: Any) -> dict[str, Any]:
    result = {"action": "kept_awake", "reason": reason, **details}
    LOGGER.info("Sleep check made no destructive change: %s", json.dumps(result))
    return result


def _wake_is_still_stale(observed_wake_ns: int) -> bool:
    current = _read_last_wake_ns()
    return current == observed_wake_ns and (
        time.time_ns() - current >= IDLE_TIMEOUT_SECONDS * 1_000_000_000
    )


def _activity_guard(
    observed_wake_ns: int,
    *,
    allow_api_service: bool = True,
    allow_missing_queue_after_proof: bool = False,
) -> tuple[str | None, dict[str, Any]]:
    if not _wake_is_still_stale(observed_wake_ns):
        return "wake_race", {}
    worker = _service(WORKER_SERVICE)
    if not _is_stopped(worker):
        return "worker_active", {"worker": _counts(worker)}
    queue_max = _queue_scale_max(datetime.now(timezone.utc))
    if queue_max is None:
        if not allow_missing_queue_after_proof:
            return "queue_metric_missing", {}
        queue_details: dict[str, Any] = {"queueZeroProof": "persisted"}
    else:
        if queue_max > 0:
            return "queue_active", {"queueScaleMaximum": queue_max}
        queue_details = {"queueScaleMaximum": queue_max}
    unexpected = _unexpected_running_tasks(allow_api_service=allow_api_service)
    if unexpected:
        return "standalone_tasks_active", {"taskCount": len(unexpected)}
    return None, queue_details


def _has_persisted_queue_zero_proof(state: dict[str, Any]) -> bool:
    return state.get("phase") in {
        QUIESCING,
        SNAPSHOTTING,
        SNAPSHOT_READY,
        DELETING,
    } and (
        state.get("quiescentSinceNs") is not None
    )


def _invalidate_snapshot_or_quiescence(state: dict[str, Any]) -> dict[str, Any]:
    updates: dict[str, Any] = {"quiescentSinceNs": None}
    if state.get("phase") in {SNAPSHOTTING, SNAPSHOT_READY}:
        updates.update({"phase": QUIESCING, "snapshotName": None, "errorType": None})
    if state.get("quiescentSinceNs") is None and "phase" not in updates:
        return state
    return _transition(state, **updates)


def _progress_sleep(state: dict[str, Any], observed_wake_ns: int) -> dict[str, Any]:
    reason, details = _activity_guard(
        observed_wake_ns,
        allow_missing_queue_after_proof=_has_persisted_queue_zero_proof(state),
    )
    if reason:
        previous_phase = state.get("phase")
        state = _invalidate_snapshot_or_quiescence(state)
        if previous_phase in {SNAPSHOTTING, SNAPSHOT_READY}:
            details["cachePhase"] = state["phase"]
        return _kept_awake(reason, **details)

    api = _service(API_SERVICE)
    if not _is_stopped(api):
        state = _invalidate_snapshot_or_quiescence(state)
        if int(api.get("desiredCount", 0)) != 0:
            _set_api_desired_count(0)
        if not _wake_is_still_stale(observed_wake_ns):
            _set_api_desired_count(1)
            return _kept_awake("wake_race_after_api_scale")
        return {"action": "quiescing", "cachePhase": state["phase"]}

    active_tasks = _unexpected_running_tasks(allow_api_service=False)
    if active_tasks:
        state = _invalidate_snapshot_or_quiescence(state)
        return _kept_awake(
            "tasks_active_after_api_scale", taskCount=len(active_tasks)
        )

    if not CACHE_HIBERNATION_ENABLED:
        state = _transition(
            state,
            desired="sleep",
            phase=SLEEPING,
            quiescentSinceNs=None,
            errorType=None,
        )
        return {"action": "slept", "cachePhase": state["phase"]}

    group = _replication_group()
    if group is None:
        snapshot_name = state.get("snapshotName")
        snapshot = _snapshot(snapshot_name) if snapshot_name else _latest_available_snapshot()
        if snapshot and str(snapshot.get("SnapshotStatus", "")).lower() == "available":
            resolved_snapshot_name = snapshot.get("SnapshotName")
            if (
                state.get("phase") == SLEEPING
                and state.get("snapshotName") == resolved_snapshot_name
            ):
                return {"action": "already_asleep", "cachePhase": state["phase"]}
            state = _transition(
                state,
                desired="sleep",
                phase=SLEEPING,
                snapshotName=resolved_snapshot_name,
                quiescentSinceNs=None,
                errorType=None,
            )
            return {"action": "slept", "cachePhase": state["phase"]}
        raise RuntimeError("Cache is absent without an available protected snapshot")

    group_status = str(group.get("Status", "")).lower()
    if state["phase"] == SNAPSHOTTING:
        snapshot_name = state.get("snapshotName")
        if not snapshot_name:
            raise RuntimeError("Snapshotting state has no protected snapshot name")
        snapshot = _snapshot(snapshot_name)
        if snapshot is None:
            raise RuntimeError("Protected cache snapshot disappeared")
        snapshot_status = str(snapshot.get("SnapshotStatus", "")).lower()
        if snapshot_status == "available" and group_status == "available":
            state = _transition(state, phase=SNAPSHOT_READY, errorType=None)
            return {"action": "snapshot_ready", "cachePhase": state["phase"]}
        if snapshot_status in {"failed", "deleted"}:
            raise RuntimeError("Protected cache snapshot failed")
        return {"action": "snapshotting", "cachePhase": state["phase"]}

    if state["phase"] == SNAPSHOT_READY:
        snapshot = _snapshot(str(state.get("snapshotName", "")))
        if not snapshot or str(snapshot.get("SnapshotStatus", "")).lower() != "available":
            raise RuntimeError("Protected snapshot is not available before deletion")
        reason, details = _activity_guard(
            observed_wake_ns,
            allow_api_service=False,
            allow_missing_queue_after_proof=_has_persisted_queue_zero_proof(state),
        )
        if reason:
            state = _invalidate_snapshot_or_quiescence(state)
            details["cachePhase"] = state["phase"]
            return _kept_awake(reason, **details)
        if not _is_stopped(_service(API_SERVICE)):
            state = _invalidate_snapshot_or_quiescence(state)
            return _kept_awake("api_active_before_delete")
        if str((_replication_group() or {}).get("Status", "")).lower() != "available":
            return _kept_awake("cache_not_available_before_delete")
        state = _transition(state, phase=DELETING, errorType=None)
        try:
            ELASTICACHE.delete_replication_group(
                ReplicationGroupId=CACHE_REPLICATION_GROUP_ID,
                RetainPrimaryCluster=False,
            )
        except Exception as error:
            _mark_error(state, error)
            raise
        return {"action": "deleting_cache", "cachePhase": state["phase"]}

    if state["phase"] == DELETING:
        if group_status == "deleting":
            return {"action": "deleting_cache", "cachePhase": state["phase"]}
        if group_status != "available":
            return _kept_awake("cache_not_available", cacheStatus=group_status)

        # The durable phase was committed but ElastiCache never accepted the
        # delete request. Re-snapshot the still-available cache before retrying
        # so a stale protected snapshot can never be used after an interruption.
        state = _transition(
            state,
            phase=QUIESCING,
            snapshotName=None,
            errorType=None,
        )

    if group_status == "deleting":
        if state["phase"] != DELETING:
            state = _transition(state, phase=DELETING, errorType=None)
        return {"action": "deleting_cache", "cachePhase": state["phase"]}

    if group_status != "available":
        return _kept_awake("cache_not_available", cacheStatus=group_status)

    if state.get("phase") != QUIESCING:
        state = _transition(
            state,
            phase=QUIESCING,
            snapshotName=None,
            quiescentSinceNs=None,
            errorType=None,
        )

    # Require two fully clear observations separated by at least one minute.
    # This allows ECS stopping transitions and delayed queue metrics to become
    # visible before a point-in-time snapshot is selected.
    quiescent_since_ns = state.get("quiescentSinceNs")
    if quiescent_since_ns is None:
        state = _transition(state, quiescentSinceNs=time.time_ns())
        return {"action": "quiescence_started", "cachePhase": state["phase"]}
    if time.time_ns() - int(quiescent_since_ns) < CACHE_QUIESCENCE_SECONDS * 1_000_000_000:
        return {"action": "quiescing", "cachePhase": state["phase"]}

    # A new manual snapshot is initiated only after all activity gates pass;
    # the primary member ID is required for cluster-mode-disabled groups.
    reason, details = _activity_guard(
        observed_wake_ns,
        allow_api_service=False,
        allow_missing_queue_after_proof=_has_persisted_queue_zero_proof(state),
    )
    if reason:
        state = _invalidate_snapshot_or_quiescence(state)
        return _kept_awake(reason, **details)
    if not _is_stopped(_service(API_SERVICE)):
        state = _invalidate_snapshot_or_quiescence(state)
        return _kept_awake("api_active_before_snapshot")
    snapshot_name = _new_snapshot_name(time.time_ns())
    primary_cluster_id = _primary_cache_cluster_id(group)
    state = _transition(
        state,
        desired="sleep",
        phase=SNAPSHOTTING,
        snapshotName=snapshot_name,
        errorType=None,
    )
    try:
        ELASTICACHE.create_snapshot(
            CacheClusterId=primary_cluster_id,
            SnapshotName=snapshot_name,
            Tags=[{"Key": key, "Value": str(value)} for key, value in CACHE_TAGS.items()],
        )
    except Exception as error:
        if _error_code(error) != "SnapshotAlreadyExistsFault":
            _mark_error(state, error)
            raise
    return {"action": "snapshotting", "cachePhase": state["phase"]}


def handle_idle_check() -> dict[str, Any]:
    try:
        observed_wake_ns = _read_last_wake_ns()
        state = _read_state()
        idle_age_ns = time.time_ns() - observed_wake_ns
        if idle_age_ns < IDLE_TIMEOUT_SECONDS * 1_000_000_000:
            if state.get("desired") != "awake":
                state = _transition(state, desired="awake", wakeRequestedNs=observed_wake_ns)
            status_code, payload = _reconcile_awake(state)
            return {
                "action": "kept_awake",
                "reason": "recent_wake",
                "wakeStatusCode": status_code,
                "cachePhase": payload["cachePhase"],
            }

        # A fully hibernated cache has no queue publisher, so CloudWatch will
        # eventually have no queue datapoints. Validate the protected snapshot
        # directly and avoid treating that expected absence as an activity error.
        if state.get("desired") == "sleep" and state.get("phase") == SLEEPING:
            group = _replication_group()
            snapshot_name = state.get("snapshotName")
            snapshot = _snapshot(str(snapshot_name)) if snapshot_name else None
            if group is None and snapshot and str(
                snapshot.get("SnapshotStatus", "")
            ).lower() == "available":
                managed_services = _managed_service_counts()
                if any(
                    value != 0
                    for counts in managed_services.values()
                    for value in counts.values()
                ):
                    return _kept_awake(
                        "managed_service_drift",
                        cachePhase=SLEEPING,
                        services=managed_services,
                    )
                return {"action": "already_asleep", "cachePhase": SLEEPING}
            if group is None:
                raise RuntimeError(
                    "Cache is absent without its protected available snapshot"
                )

        if state.get("desired") == "awake" and state.get("phase") in {
            DELETING,
            RESTORING,
            API_STARTING,
        }:
            status_code, payload = _reconcile_awake(state)
            return {
                "action": "reconciling_wake",
                "wakeStatusCode": status_code,
                "cachePhase": payload["cachePhase"],
            }

        if state.get("desired") != "sleep" or state.get("phase") == ACTIVE:
            state = _transition(
                state,
                desired="sleep",
                phase=QUIESCING,
                quiescentSinceNs=None,
                errorType=None,
            )
        return _progress_sleep(state, observed_wake_ns)
    except StateConflict:
        return _kept_awake("state_conflict")
    except Exception as error:
        LOGGER.exception("API/cache sleep check failed open")
        try:
            error_state = locals().get("state")
            if error_state is None:
                error_state = _read_state()
            _mark_error(error_state, error)
        except Exception:
            LOGGER.exception("Failed to load state while recording sleep error")
        return _kept_awake("dependency_error", errorType=type(error).__name__)


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    if event.get("action") == "idle_check":
        return handle_idle_check()
    return handle_wake(event)
