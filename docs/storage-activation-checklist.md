# Storage Activation Checklist

- Confirm selected upload storage driver (`local`, `r2`, `s3`).
- Run `validateStorageDriverEnv()` and confirm required env keys are present.
- Confirm `getStorageActivationStatus()` returns `ready`.
- Confirm public URL generation matches expected production domain.
- Confirm delete adapter behavior is restricted to owned URLs.
- Confirm fallback behavior is explicit and logged when env is incomplete.
- Confirm no production cutover command is executed in this phase.
