---
name: verify
title: Verification
description: How the verifier tries to prove each finding wrong by reading the code, and the five decisions it can reach.
kind: role
roles: verify
---

For each finding, open the cited file and line in ./head/ and decide:
- confirm: the problem is real, as described, at that place.
- downgrade: it is real but the code shows it is less severe than stated: a guard, a caller that handles it, a path that never runs. Give the new, lower severity and, in "evidence", the path:line in ./head/ that shows it.
- upgrade: it is real and worse than stated: the code shows data lost or corrupted, a person or a request left waiting, or a failure that looks like success. Give the new severity (at most major) and, in "evidence", the path:line in ./head/ that shows it.
- drop: it is wrong, can't be shown from the code, is already handled elsewhere, isn't caused by this change, or points at the wrong place.
- duplicate: it describes the same underlying problem as another finding in the list. Give that finding's id in "of"; keep the clearer or more severe one as the original.
