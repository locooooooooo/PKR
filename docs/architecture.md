# PKR architecture

PKR is a Provider-neutral project framework and local reference Runtime. The
Runtime owns authoritative project state in SQLite. Agent hosts, Provider
Adapters, repository tools, and LPS are interchangeable boundaries around that
authority, not alternate control planes.

```mermaid
flowchart LR
    H["Human owner"] --> S["Governed Steward"]
    S --> R["PKR Runtime"]
    R <--> DB["SQLite authority"]
    R --> L["LPS derived orchestration"]
    L --> A["Generic Agent or Provider Adapter"]
    A --> W["Scoped repository Workspace"]
    A --> WR["Non-authoritative work report"]
    WR --> R
    W --> V["Independent Repository Verification"]
    V --> R
    R --> AC["Separate Runtime acceptance"]
```

The four evidence layers are deliberately distinct:

1. SQLite records and ordered events are authoritative Runtime state.
2. Agent and Provider reports describe attempted work but cannot accept it.
3. Repository Verification recomputes live Git and command evidence.
4. Runtime acceptance is a separate guarded transition after Verification.

PKR constrains host execution with scopes, structured arguments, timeouts,
digests, and audit records. It is not an operating-system sandbox, container,
credential vault, hosted control plane, or production SLA. Brand-specific Agent
host examples may appear only in optional integration documents and do not
change these boundaries.
