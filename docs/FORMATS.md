# Formats

A review document is `hoop/review@0`, and feedback is `hoop/feedback@0`. Both are published as JSON
Schema in [`schemas/`](../schemas/), and the tables below come from the same source. An item's lines
are its body lines, then a question's choices, then its check. Line 0 is the item's heading. Item
`DOC` line 1 is the title and line 2 the TL;DR.

A review document:

<!-- fields:review -->
| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema` | `"hoop/review@0"` | yes | The format and its version. |
| `review_id` | string or null | no | Set to revise an existing review. |
| `revision` | integer | no | Set by hoop: the revision number. |
| `kind` | `requirements`, `slice_map`, `plan`, `questions`, `decision`, `doc` | yes | What the document is; doc for any markdown document. |
| `slug` | string | yes | A short name for the document, such as order-export. |
| `title` | string | yes | The document's title. |
| `tldr` | string | yes | One or two sentences for the reviewer. |
| `context` | object | no | Where the document comes from: a repository, a branch and links. |
| `items` | list of object | yes | The document's items, in order. |
| `asks` | `approve_all`, `per_item`, `choose` | no | What the agent asks the reviewer to do. |
| `tldr_auto` | boolean | no | True when the TL;DR was copied from the first paragraph: edit that paragraph, not the TL;DR. |
| `spacing` | `"exact"` | no | With exact, blank lines around headings are kept in section bodies and exported as they are. |
<!-- /fields:review -->

An item:

<!-- fields:item -->
| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | The item's ID, such as FR-3; unique in the document. |
| `type` | `requirement`, `slice`, `step`, `question`, `option`, `note`, `section` | yes | What the item is. |
| `title` | string | yes | The item's heading. |
| `body` | string | no | The item's text; each non-empty line is one line to comment on. |
| `check` | string | no | How a test or a reviewer checks the item. |
| `choices` | list of object | no | A question's options. |
| `risk` | `low`, `medium`, `high` | no | The agent's estimate of the item's risk. |
| `depends_on` | list of string | no | IDs of items this one needs first. |
| `level` | integer | no | A document section's heading level; 0 for text before the first heading. |
<!-- /fields:item -->

Feedback:

<!-- fields:feedback -->
| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema` | `"hoop/feedback@0"` | yes | The format and its version. |
| `review_id` | string | yes | The review this feedback is on. |
| `revision` | integer | yes | The revision it was given on. |
| `verdict` | `comment`, `approved`, `changes_requested` | yes | The reviewer's verdict; approving or requesting changes on the page needs a GitHub sign-in. |
| `summary` | string | no | An overall comment, or an approval's notes. |
| `comments` | list of object | no | Comments and replies. |
| `answers` | list of object | no | Answers to questions: each question's ID and the chosen option, or the reviewer's own words. |
| `resolved_threads` | list of string | no | Threads this feedback resolves. |
| `viewed` | list of string | no | Items the reviewer marked as viewed. |
| `reviewer` | string | yes | Who gave it, as they named themselves. |
| `at` | string | yes | When, as an ISO 8601 time. |
| `signed_in` | object | no | The person's GitHub login, when the verdict came with their sign-in in the browser. |
<!-- /fields:feedback -->

A comment:

<!-- fields:comment -->
| Field | Type | Required | Meaning |
|---|---|---|---|
| `thread` | string | no | The thread a reply belongs to; leave out for a new comment. |
| `item` | string | yes | The item's ID, or DOC for the title and TL;DR. |
| `line` | integer | yes | The line, from 1; 0 is the item's heading, and DOC line 1 is the title and 2 the TL;DR. |
| `range` | object | no | The words the comment is about, inside the line. |
| `body` | string | no | The comment's text. |
| `suggestion` | string | no | Replacement text for the range, or for the whole line. |
<!-- /fields:comment -->
