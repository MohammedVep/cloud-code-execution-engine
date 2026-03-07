# Demo Script

## Goal
Show a realistic execution platform flow with queueing, sandboxing, failures, and observability signals.

## Recording Order
1. Open homepage and quickly show architecture cards.
2. Submit a normal JavaScript execution.
3. Show status transitions (`queued` -> `running`/`dispatched` -> `succeeded`).
4. Open history and audit panels.
5. Run a timeout example (`while(true){}` with low timeout) to show `timed_out`.
6. Run a syntax/runtime error example to show `failed`.
7. Trigger AI analysis on latest failed run.
8. Summarize security/scaling model and worker autoscaling metric.

## Example Payloads
### Success
```javascript
console.log("hello from demo")
```

### Timeout
```javascript
while (true) {}
```

### Runtime failure
```javascript
throw new Error("demo failure")
```

## Talking Points
- Jobs are queued, not executed inline with request/response.
- Untrusted code runs in isolated runtime with strict resource boundaries.
- Tenant quotas and burst limits prevent abuse.
- Audit stream captures critical lifecycle and security events.
- Queue-depth metrics drive worker autoscaling.
