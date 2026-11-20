---
description: Review this branch with Crewreview, or show what the crew is doing
argument-hint: "[review | status | inbox]"
---

The user ran `/crewreview $ARGUMENTS`.

- With no argument or `review`: call the `crewreview_review_local` tool for the current repository (pass `uncommitted: true` if there are uncommitted changes the user cares about). It takes a few minutes. Then summarize the verdict and list the findings by severity with `file:line`, blockers first. Offer to fix the blockers and majors, checking each claim in the code before changing anything.
- With `status`: call `crewreview_status` and say in a few lines what the crew watches and what waits in the inbox.
- With `inbox`: call `crewreview_inbox`, and `crewreview_inbox_item` for anything the user wants to see. Approving is the user's call: point them to `crewreview ui` or `crewreview inbox approve <id>`.

If the `crewreview` tools aren't available, Crewreview isn't installed or isn't on the PATH: tell the user to install it (`curl -fsSL https://crewreview.web.app/install.sh | sh`, or `brew tap Quost/crewreview https://github.com/Quost/crewreview && brew trust quost/crewreview && brew install Quost/crewreview/crewreview`) and run `crewreview doctor`.
