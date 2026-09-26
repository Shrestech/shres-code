# S-trial effective-config preflight

An S trial compares each logged `request/header.config` to **one** `prepareCall(currentSelection()).config` computed before consults. C trials skip that call. Consults still pass unprepared `currentSelection()` into `replayConsultInput`.

After `--resume`, adapter-default markers may change while the effective call stays the same; proposal equality would refuse those trials. A mismatch of any present `LlmCallConfig` field is still `request-config-mismatch`.
