# Docs and claims

Do the change's own statements, and what the project writes down about the changed code, still match what the code does?

Work from ./ctx/docs.md (settings the change reads, docs that name what it changed), ./ctx/pr.md, ./ctx/change.md and ./ctx/guidelines.md:

- Claims. Collect the statements about the code that can be checked: in the description, the commit messages, and the docs or decision records the change adds or edits. "Already exists", "blocked on the server", "only X calls Y", "idempotent", "no behavior change", a record or a line it cites. Check each against ./head/. A claim the code contradicts is a finding at the line that contradicts it.
- Docs left behind. Open each doc that ./ctx/docs.md lists for a changed file or function, and compare what it promises (a guarantee, a step, a default, a flag, an order) with what the code does now. A statement this change made false is a finding at the doc's line.
- Settings. A variable the change starts reading belongs wherever this project lists its settings (an environment example, deploy or operations notes); one it stops reading should leave them. Name the file that is missing it.
- Translations. A user-facing string added or changed where the project translates, missing or different in its translation files (.po, .pot, locale files).
- Decision records the change adds, edits or cites: does the code do what they decide, does one contradict another, and is an accepted record rewritten where the project's rules say to supersede it?
- The project's own written rules about docs, settings, changelogs, migrations or the pull request itself (a checklist, a required section). Check the ones that can be checked by reading.

Severity follows what happens to someone who believes the text. A setting missing from the deploy notes, or a guarantee that no longer holds, is at least minor; major when acting on it breaks production or loses data. Wording and typos are nits, and only where the project asks for it.

Judge the text against the code; the code itself is the other lenses' job.
