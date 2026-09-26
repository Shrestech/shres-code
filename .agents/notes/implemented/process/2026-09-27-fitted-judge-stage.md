# Fitted-judge stage (prepare-only by default)

`judgeReplayRows` asks the composed fitting engine once per eligible consult. `hostReplayTrial` / `hostReplayRun` take `judge` defaulting to false, so prepare-only runs make zero judgment calls. Calibration uses public `ctx.judgmentEngines.get(id).descriptor.calibration` with `routingCalibration`.
