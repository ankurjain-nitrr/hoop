---
name: writing-style
description: The writing rules for every project document and work item (PRD, HLD, LLD, tracker items, and task and PR titles and descriptions). Text must be complete sentences in simple language with no em or en dashes, and a script checks it. Use whenever writing or editing any of these, before submitting one for review, or for "check the writing", "writing rules" or "lint the docs". The other devloop skills apply it; it does not apply to a requester's own words in REQUEST.md.
---

# Writing rules

These rules apply to all text in a PRD, HLD, LLD and tracker. They also apply to the titles and
descriptions of work items, tasks and pull requests. They are strict: a document isn't ready for review until
the checker reports nothing.

## The rules

1. **Write complete sentences, not phrases.** Every list item, table cell that holds prose, and
   paragraph is one or more full sentences. Each has a subject and a verb, starts with a capital
   letter and ends with a period. Write "The registry stores each request as written." and not
   "Registry: request storage". A work item title is a sentence too: "Add a tracker page that shows
   the work as a tree." and not "Tracker page".
2. **Use simple language.** Use common words, short sentences (25 words at most), active voice,
   and one idea per sentence. Define a term the first time you use it, or use a plainer word.
3. **Don't put dashes between words.** That means no em dash (`—`), no en dash (`–`) and no
   spaced hyphen (` - `). Use a period, a comma, a colon or parentheses.
   Arrows (→) are fine for an order of steps, as in "PRD → HLD → LLD".

What is exempt:
- Headings, code and file paths are exempt.
- A table cell is exempt when it holds only an identifier, status, number, date, name, ID list or
  link.
- A document's metadata line (`Status: ... · Revision: ...`) is exempt.
- The requester's own words are exempt. `REQUEST.md` keeps them exactly as written, and quotes
  keep their original form.

## Check before review

Run the checker on every file you wrote or changed:

```sh
python3 <this skill's directory>/scripts/check_writing.py docs/PRD.md docs/HLD.md ...
```

It reports each line that breaks a rule, with the rule and a hint, and exits 1 if there is any.
Fix every finding by rewriting the text, then run it again until it reports nothing. Don't edit
the text just to pass the check: a sentence that ends with a period but has no verb still breaks
rule 1. The checker can't see that, so read each finding's neighbors too.

Sometimes a finding is wrong, for example when the checker takes an identifier for prose. Then
keep the text and say so in the review. Don't add filler words to pass.
