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

## Alternatives Considered
- **EC2 + Docker**: lower cost, higher operational load, weaker isolation boundary.
- **EC2 + gVisor/Kata**: stronger isolation but significant operational complexity and ongoing maintenance.
- **EKS + gVisor**: solid isolation but higher control-plane and cluster lifecycle overhead for this workload.
