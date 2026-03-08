# ADR 0001: Why We Chose AWS Fargate over EC2 for Multi-Tenant Code Execution

## Status
Accepted

## Context
We run untrusted, multi-tenant code execution workloads that require strong isolation guarantees, predictable performance, and minimal operational overhead. Managing EC2 fleets, custom AMIs, and kernel-level sandboxing (gVisor/Kata) adds operational complexity and increases the blast radius of misconfiguration. For a code execution platform, the isolation boundary is the primary security control.

## Decision
We run worker and runner tasks on AWS Fargate rather than EC2. Fargate uses AWS Firecracker microVMs under the hood, providing hardware-virtualization-grade isolation between tasks without us maintaining host kernels, daemonsets, or custom sandbox runtimes. This lets us focus on application-level protections (resource limits, quota enforcement, audit trails) while inheriting a strong isolation boundary.

## Consequences
- Security posture improves through microVM isolation, reducing container breakout risk compared to shared-host Docker.
- Operational overhead drops: no EC2 autoscaling groups, AMI patching, or host-level sandbox lifecycle.
- Cost model becomes per-task with scale-to-zero possible for workers.
- We accept the Fargate platform limits (kernel features, storage constraints, and slower cold starts) as a tradeoff for isolation and simplicity.

## FinOps Proof: Scale-to-Zero Verification
To verify idle-cost control, we capture Application Auto Scaling activity records that show the worker service returning to zero desired tasks after backlog drain.

CloudWatch scaling activity (captured on March 8, 2026):

```json
{
  "ActivityId": "ef1e1707-93b5-4366-a6c3-41369f237019",
  "ServiceNamespace": "ecs",
  "ResourceId": "service/ccee-cluster/ccee-worker",
  "ScalableDimension": "ecs:service:DesiredCount",
  "Description": "Setting desired count to 0.",
  "Cause": "monitor alarm TargetTracking-service/ccee-cluster/ccee-worker-AlarmLow-5c85abac-b629-4b92-9792-adf3287ce611 in state ALARM triggered policy ccee-worker-queue-depth",
  "StartTime": "2026-03-08T13:31:06.701000-04:00",
  "StatusCode": "Successful"
}
```

## Alternatives Considered
- **EC2 + Docker**: lower cost, higher operational load, weaker isolation boundary.
- **EC2 + gVisor/Kata**: stronger isolation but significant operational complexity and ongoing maintenance.
- **EKS + gVisor**: solid isolation but higher control-plane and cluster lifecycle overhead for this workload.
