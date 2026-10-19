---
name: review-comments
description: How to write a good review comment and how to answer one, for any document or change in any field. It covers labels, blocking or not, one point per comment, a way forward, the two-cycle limit and the owner's final decision. Use when reviewing a document or a change, when answering review comments, or for "how should I phrase this comment".
---

# Review comments

These rules work for any review, whatever the subject: requirements, designs, code, policies or
prose.

## Traits of a good review comment

1. **It is labeled.** Start with what kind of comment it is: issue, suggestion, question, nitpick or
   praise. Mark it blocking or non-blocking. A nitpick is never blocking.
2. **It makes one point.** Split a comment that raises two things.
3. **It is anchored and specific.** Put it on the exact line or words it is about, and quote the
   source it relies on, such as a requirement or a decision.
4. **It says why.** Explain the effect on the people the work is for, or on the goal. A blocking
   comment names the principle it rests on, from `devloop:principles`, such as "Start from the
   customer" or "Do the simple thing that works".
5. **It offers a way forward.** Pair every issue with a suggestion, a smaller step or a question
   that would settle it.
6. **It asks when unsure.** Use a question when you aren't sure there is a problem.
7. **It is about the work, not the person.** Be kind and direct, and assume good intent.
8. **It is short.** A reader should get the point in one pass.
9. **It praises what is good, truthfully.** Note a strong choice when there is one, never as filler.

## Stay at your altitude

Each role reviews at its own level, and the other levels catch the rest. A comment below your level
costs the owner a revision and hides the comments only you can make.

- Before you post, ask two questions of each comment. Does my role own this question? Would the
  stage below mine catch it anyway: the LLD review, the code check, or the code review?
- Post it when your role owns it. Otherwise drop it, or hand it down in one line that starts with
  "For the LLD:" or "For code review:". Make at most two such lines in a review, and never block on
  them.
- A comment sits at the right level when it changes what your document type decides. A PRD decides
  what users get, an HLD decides the system's shape, and an LLD decides the contracts between parts.
- Read code to confirm a claim at your level, not to review the code.

## Answering a comment, rounds and the final call

- A cycle is one comment or reply from a reviewer and one answer from the owner.
- Each reviewer gets at most two cycles on a thread. After that, the owner makes the call.
- The owner answers every comment by doing one of these:
  - Accept: change the document, and reply with what changed.
  - Decline: reply with the reason, in terms of the principles above.
  - Ask: reply with a question, which counts as the owner's answer for the cycle.
- When a thread ends without agreement, the owner replies "Decision: <what and why>." The reviewer
  disagrees and commits, and the thread stays as the record.
- Every resolution is written in the thread on the document, so anyone can see why the document
  says what it says.

## Who decides

The owner of a piece of work decides. The requester's approval of the whole work is the last word.
