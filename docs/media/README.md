# Demo media and evidence

These images and the [captioned video](https://github.com/maximilliangrand/replan/releases/download/v0.2.0/replan-recovery-demo.mp4)
were captured from the local Replan browser on 2026-09-23. The application code
was revision `2e2d38fa4549990e81bf00df59fc753a5565c1b3`; the v0.2.0 launch change
adds documentation, media, the exported run and release metadata.

The video is 90 seconds of actual browser interaction. Opening setup was trimmed
and explanatory captions were added beneath the application. No operational
steps were removed or reordered, and playback is at the captured speed. It is
silent; a [subtitle file](https://github.com/maximilliangrand/replan/releases/download/v0.2.0/replan-recovery-demo.srt)
provides the caption text separately. All factories, inventory, carrier records
and costs are synthetic. Dispatch is not delivery.

| Asset                                       | What it shows                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Workbench](replan-workbench.png)           | The $440 optimized and $475 greedy proposals, transfer allocations and specific approval.        |
| [Uncertain outcome](replan-uncertain.png)   | No application-confirmed transfers, but one independent carrier dispatch and a held reservation. |
| [Recovered operation](replan-recovered.png) | Three confirmed dispatches and $615 total committed cost.                                        |

The [audit from this recording](../evidence/launch-demo-recovery.json) is
separate from the historical hosted $440 recovery run. Its offline verification
reports 39 events, two approvals, three dispatch intents, three distinct
order dispatches, $615 committed cost and no unresolved plan. One historical
plan remains marked `needs_replan`; its changed remainder was completed by the
replacement plan. This preserves the original decision history.

```sh
npm ci
npm run verify:export -- docs/evidence/launch-demo-recovery.json
```

The export is unsigned and the verifier checks consistency, not authenticity or
physical execution. Follow the [walkthrough](../demo.md) to reproduce the
sequence. The recording does not include a process crash; separate integration
and HTTPS browser tests exercise restart recovery.
