# Agent Note: Composer edits carry the range they applied to

Status: implemented

## Problem

The input machine keeps its reference occurrences aligned by reconciling them against one edit range: entries before the range shift, entries after it hold, and an entry the range intersects loses its structured identity and stays behind as ordinary draft text. That last rule is the deliberate meaning of editing inside a reference.

Ordinary typing supplied no range. A controlled textarea's change event carries only the resulting string, so the machine recovered the range by scanning the two drafts for a common prefix and suffix. That recovery is ambiguous whenever the inserted text repeats the text it lands against, and the greedy scan always resolves the ambiguity the same way: it slides the edit as late as the characters allow.

A later composer that stores a reference as literal `@` plus its label produces exactly that collision when the user types `@` immediately before one. Shres still stores references as a one-character placeholder, so that particular keystroke is not reachable yet; the same scan is still wrong for any insert or caret delete whose resulting characters are also consistent with a later offset, including a caret word-delete that removes more than one character.

## Decision

`InputBar` records the textarea's selection and `inputType` during `beforeinput` and passes the resulting range to `setDraft`, which the machine already accepts and prefers over its own scan. A textarea exposes the edit no other way — `getTargetRanges()` is empty for form controls.

An edit that replaces a selection reports that selection, and it is the range outright; the inserted length is whatever the draft grew by once the replaced range is accounted for. A caret delete replaces nothing and reports the bare caret, so its range comes from the direction `inputType` names and the number of characters the draft actually lost. The count is measured rather than assumed to be one, because a single caret gesture removes a multi-unit grapheme, a word, or a line just as readily.

Only the `insert` and `delete` families are recorded. A history replay reports wherever the caret happens to sit, which would survive every check while naming the wrong span; ignoring it leaves that path on the scan.

The record is consumed once and cleared. A record whose draft length disagrees with the draft the change reports, a selection past the draft, a shrinking edit over a selection the caret cannot explain, or an undirected delete all yield no range, and the machine falls back to its scan. Paste and the boundary Backspace and Delete gestures already supplied their own ranges and are untouched.

## Alternatives considered

**Disambiguate the scan with the post-edit caret.** The caret pins which of the textually equivalent readings happened, and the change event already carries it. Rejected because it keeps a reconstruction where an exact fact is available, and it cannot separate the deleted and inserted halves of a replaced selection at all.

**Give references a leading marker no keystroke produces.** Rejected as a representation change to buy what an exact range buys directly, and it would leave ordinary typing reconstructing its range for every other reason.

**Widen reconcile to keep an occurrence when the range only touches its edge.** Rejected because a misattributed offset can land strictly inside the occurrence, not on its boundary.

## Consequences

Every native textarea edit that reaches `onChange` now names the range it applied to, so occurrence offsets follow the edit that actually happened rather than one merely consistent with the resulting characters. Draft writes that originate in the facade rather than the DOM — `insertText` and the command-token splices among them — still carry no range and keep the scan, as do the fallbacks above.

The composer now depends on `beforeinput` preceding each value change, and on `inputType` naming the direction of a caret delete. Any future edit path that mutates the value without either silently returns to the scan rather than breaking.

## Testing

Component tests cover an insert immediately before a placeholder chip, a caret Backspace, and a caret word delete, asserting in each case that the occurrence survives at the shifted offset.
