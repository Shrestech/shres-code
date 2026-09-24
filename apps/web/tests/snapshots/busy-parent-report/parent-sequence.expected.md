spliced target=next-turn inserted=[user] removed=0
turn/start
spliced target=next-turn inserted=[] removed=1
step/start turn=1 step=1
user/message source=user text=Delegate two progress reports to a background subagent, then answer.
step/start turn=1 step=2
spliced target=next-step inserted=[subagent-report] removed=0
spliced target=next-step inserted=[subagent-report] removed=0
spliced target=next-step inserted=[subagent-settled] removed=0
spliced target=next-step inserted=[] removed=3
step/start turn=1 step=3
user/message source=subagent-report text=Background subagent {{childId}} reported:PROGRESS_ONE
user/message source=subagent-report text=Background subagent {{childId}} reported:PROGRESS_TWO
user/message source=subagent-settled text=Background subagent {{childId}} finished and will do no further work unless you send it more.Its closing message:CHILD_DONE
