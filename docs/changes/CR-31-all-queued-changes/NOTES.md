# CR-31: notes

Captured on 2026-10-20 with `hoop cr create`. The type is epic. The project is hoop.

## What the request means

The requester merged every queued change into this one. It is built in one go, on one branch, and
lands as one pull request. The merged changes keep their requests and notes in their own folders,
and each one says it was merged here.

| Change | Area | What it brings |
|---|---|---|
| CR-30 | Document rules | PRDs hold no code, and HLDs and LLDs point only to requirements. |
| CR-20 | Repository setup | Self-contained tests, commit hooks, linting, CI and open source files. |
| CR-23 | Agent tools | The core review tools by default, and devloop's tools per project. |
| CR-24 | Agent tools | One clear way to submit, and results that state their outcome. |
| CR-26 | Agent tools | Waiting for feedback through MCP alone. |
| CR-27 | Checks | A skipped check reads as a warning, and allowing it takes one step. |
| CR-25 | Comments and edits | Quoted anchors, stated edit rules, and deleting or editing in place. |
| CR-12 | Document structure | Nested sections, stable section comments, tables and diagrams. |
| CR-14 | Trust | Agents only comment or approve as agents, with a GitHub sign-in for the final approval. |
| CR-11 | Tracker | Item descriptions and definitions of done on the tracker page. |
| CR-16 | Changes | A change request page, with each change's checks recorded. |
| CR-7 | Changes | A kind and a project on every change, with filters and moves. |
| CR-28 | README | A README for new users, with schemas, a glossary and a stability policy. |

## The requester's decisions (2026-10-20)

- All thirteen queued changes are merged into this one.
- It lands as one pull request. This sets aside intake's limit of five pull requests for one
  change, at the requester's explicit choice. The requester saw the cost: a very large review.
- The requester approves the PRD, the HLD and the LLD once each on the page. Agent reviewers
  review each first. After that the build runs to the end without stopping.
- The markdown submit tool becomes `hoop_submit`. The decision tool becomes `hoop_submit_decision`.
  The old names keep working for one release.
- The final approval uses GitHub's device sign-in.
- Commit hooks are plain git hooks kept in the repository, and Biome lints and formats.
- Mermaid diagrams render from a copy that hoop serves itself.

## Carried over

- CR-30's PRD was approved at revision 3. This change adopts its requirements unchanged.
- CR-30's HLD revision 1 was approved, and revision 2 holds the fixes from its review. This
  change's HLD starts from revision 2.

## Capture check

The verdict is new. Every overlap between the merged changes is now inside one change, so their
order becomes the build order in the plan. No other change is queued.

## For the fold

- The LLD keeps the sign-in ID in the page's own storage and sends it in a header, not a cookie.
  Browsers share cookies across ports on one host. The fold updates the HLD's sign-in service row,
  which names a cookie.

## Fact map

The fold moved the project PRD to the five sections, and took every change request name out of
the project HLD and LLD. Each row says where one fact of the old documents went. The map script
checks every row against the new documents.

| Fact | Old place | New place |
|---|---|---|
| Title and status line, with the list of folded change requests. | PRD, title and status line. | "hoop PRD". |
| The folded change request list in the status line. | PRD, status line. | Each requirement's change tag, as in FR-1 and FR-57. |
| The product goal. | PRD, "Goal". | "Problem". |
| Work continues only when the document is approved. | PRD, "Goal". | "Problem", FR-7. |
| Driver persona. | PRD, "Users". | "Target personas". |
| Reviewer persona. | PRD, "Users". | "Target personas". |
| Agent persona. | PRD, "Users". | "Target personas". |
| The requirements section. | PRD, "Requirements". | "User interactions and flows". |
| The group "Submit and read back". | PRD, "Requirements". | "An agent submits a document", "An agent waits for a review and reads it". |
| The group "Review on the local page". | PRD, "Requirements". | "A reviewer reviews on the local page". |
| The group "Team review on GitHub". | PRD, "Requirements". | "A team reviews on GitHub". |
| The group "Any document, and comments that become edits". | PRD, "Requirements". | "An agent submits a document", "Comments become edits". |
| The group "Improvement loop". | PRD, "Requirements". | "The improvement loop". |
| The group "Changes and devloop (CR-3)". | PRD, "Requirements". | "A team tracks changes and work", "An agent's tools and commands". |
| The group "A consistent interface (CR-9)". | PRD, "Requirements". | "Every page looks and reads the same". |
| The group "Documents are checked on submit (CR-10)". | PRD, "Requirements". | "A project checks its documents on submit". |
| The group "Conversations and hidden comments (CR-13)". | PRD, "Requirements". | "Conversations and hidden comments". |
| The group "One current pages server (CR-22)". | PRD, "Requirements". | "The pages server". |
| The group "Non-functional". | PRD, "Requirements". | "Quality bars". |
| FR-1. | PRD, "Requirements", Submit and read back. | FR-1. |
| FR-2. | PRD, "Requirements", Submit and read back. | FR-2. |
| FR-5. | PRD, "Requirements", Submit and read back. | FR-5. |
| FR-8. | PRD, "Requirements", Submit and read back. | FR-8. |
| FR-11. | PRD, "Requirements", Submit and read back. | FR-11. |
| FR-3. | PRD, "Requirements", Review on the local page. | FR-3. |
| FR-4. | PRD, "Requirements", Review on the local page. | FR-4. |
| FR-4a. | PRD, "Requirements", Review on the local page. | FR-4a. |
| FR-6. | PRD, "Requirements", Review on the local page. | FR-6. |
| FR-7. | PRD, "Requirements", Review on the local page. | FR-7. |
| FR-10. | PRD, "Requirements", Review on the local page. | FR-10. |
| FR-19. | PRD, "Requirements", Review on the local page. | FR-19. |
| FR-12. | PRD, "Requirements", Team review on GitHub. | FR-12. |
| FR-13. | PRD, "Requirements", Team review on GitHub. | FR-13. |
| FR-14. | PRD, "Requirements", Team review on GitHub. | FR-14. |
| FR-15. | PRD, "Requirements", Team review on GitHub. | FR-15. |
| FR-16. | PRD, "Requirements", Any document, and comments that become edits. | FR-16. |
| FR-17. | PRD, "Requirements", Any document, and comments that become edits. | FR-17. |
| FR-18. | PRD, "Requirements", Any document, and comments that become edits. | FR-18. |
| FR-20. | PRD, "Requirements", Any document, and comments that become edits. | FR-20. |
| FR-21. | PRD, "Requirements", Any document, and comments that become edits. | FR-21. |
| FR-22. | PRD, "Requirements", Any document, and comments that become edits. | FR-22. |
| FR-23. | PRD, "Requirements", Improvement loop. | FR-23. |
| FR-24. | PRD, "Requirements", Improvement loop. | FR-24. |
| FR-25. | PRD, "Requirements", Changes and devloop (CR-3). | FR-25. |
| FR-26. | PRD, "Requirements", Changes and devloop (CR-3). | FR-26. |
| FR-27. | PRD, "Requirements", Changes and devloop (CR-3). | FR-27. |
| FR-28. | PRD, "Requirements", Changes and devloop (CR-3). | FR-28. |
| FR-29. | PRD, "Requirements", Changes and devloop (CR-3). | FR-29. |
| FR-30. | PRD, "Requirements", Changes and devloop (CR-3). | FR-30. |
| FR-31. | PRD, "Requirements", Changes and devloop (CR-3). | FR-31. |
| NFR-8. | PRD, "Requirements", Changes and devloop (CR-3). | NFR-8. |
| NFR-9. | PRD, "Requirements", Changes and devloop (CR-3). | NFR-9. |
| NFR-10. | PRD, "Requirements", Changes and devloop (CR-3). | Retired. |
| FR-32. | PRD, "Requirements", A consistent interface (CR-9). | FR-32. |
| FR-33. | PRD, "Requirements", A consistent interface (CR-9). | FR-33. |
| FR-34. | PRD, "Requirements", A consistent interface (CR-9). | FR-34. |
| FR-35. | PRD, "Requirements", A consistent interface (CR-9). | FR-35. |
| FR-36. | PRD, "Requirements", A consistent interface (CR-9). | FR-36. |
| FR-37. | PRD, "Requirements", A consistent interface (CR-9). | FR-37. |
| FR-38. | PRD, "Requirements", A consistent interface (CR-9). | FR-38. |
| FR-39. | PRD, "Requirements", A consistent interface (CR-9). | FR-39. |
| FR-40. | PRD, "Requirements", A consistent interface (CR-9). | FR-40. |
| NFR-11. | PRD, "Requirements", A consistent interface (CR-9). | NFR-11. |
| NFR-12. | PRD, "Requirements", A consistent interface (CR-9). | NFR-12. |
| FR-41. | PRD, "Requirements", Documents are checked on submit (CR-10). | FR-41. |
| FR-42. | PRD, "Requirements", Documents are checked on submit (CR-10). | FR-42. |
| FR-43. | PRD, "Requirements", Documents are checked on submit (CR-10). | FR-43. |
| FR-44. | PRD, "Requirements", Documents are checked on submit (CR-10). | FR-44. |
| NFR-13. | PRD, "Requirements", Documents are checked on submit (CR-10). | NFR-13. |
| FR-45. | PRD, "Requirements", Conversations and hidden comments (CR-13). | FR-45. |
| FR-46. | PRD, "Requirements", Conversations and hidden comments (CR-13). | FR-46. |
| FR-47. | PRD, "Requirements", Conversations and hidden comments (CR-13). | FR-47. |
| FR-48. | PRD, "Requirements", One current pages server (CR-22). | FR-48. |
| FR-49. | PRD, "Requirements", One current pages server (CR-22). | FR-49. |
| FR-50. | PRD, "Requirements", One current pages server (CR-22). | FR-50. |
| FR-51. | PRD, "Requirements", One current pages server (CR-22). | FR-51. |
| FR-52. | PRD, "Requirements", One current pages server (CR-22). | FR-52. |
| FR-53. | PRD, "Requirements", One current pages server (CR-22). | FR-53. |
| FR-54. | PRD, "Requirements", One current pages server (CR-22). | FR-54. |
| FR-55. | PRD, "Requirements", One current pages server (CR-22). | FR-55. |
| FR-56. | PRD, "Requirements", One current pages server (CR-22). | FR-56. |
| FR-57. | PRD, "Requirements", One current pages server (CR-22). | FR-57. |
| NFR-14. | PRD, "Requirements", One current pages server (CR-22). | NFR-14. |
| NFR-15. | PRD, "Requirements", One current pages server (CR-22). | NFR-15. |
| NFR-16. | PRD, "Requirements", One current pages server (CR-22). | NFR-16. |
| NFR-1. | PRD, "Requirements", Non-functional. | NFR-1. |
| NFR-2. | PRD, "Requirements", Non-functional. | NFR-2. |
| NFR-3. | PRD, "Requirements", Non-functional. | NFR-3. |
| NFR-4. | PRD, "Requirements", Non-functional. | NFR-4. |
| NFR-5. | PRD, "Requirements", Non-functional. | NFR-5. |
| NFR-6. | PRD, "Requirements", Non-functional. | NFR-6. |
| NFR-7. | PRD, "Requirements", Non-functional. | NFR-7. |
| "Since CR-9" (automatic TL;DR shows once). | PRD, FR-3. | FR-3. |
| "Since CR-13" (resolved thread as a summary row). | PRD, FR-6. | FR-6. |
| "Since CR-10" (submit result carries checks). | PRD, FR-16. | FR-16. |
| "(CR-2)" (blank lines around headings). | PRD, FR-17. | FR-17. |
| "Since CR-10" (audit counts checks). | PRD, FR-24. | FR-24. |
| "(CR-3)" on the changes group. | PRD, PRD, "Requirements". | FR-25 to FR-31. |
| "Since CR-22" (trackers of each open repository). | PRD, FR-30. | FR-30. |
| "before CR-3" (older trackers still load). | PRD, NFR-9. | NFR-9. |
| "(CR-8)" on the rule written once. | PRD, NFR-10. | HLD.md. |
| "CR-10 updated the snapshot". | PRD, NFR-10. | HLD.md. |
| "(CR-9)" on the consistent interface group. | PRD, PRD, "Requirements". | FR-32 to FR-40. |
| "Since CR-22" (page names its repository, list names each row's repository). | PRD, FR-32. | FR-32, FR-34. |
| "(CR-9)" on NFR-11. | PRD, NFR-11. | NFR-11. |
| "(CR-9)" on NFR-12. | PRD, NFR-12. | NFR-12. |
| "(CR-10)" on the checks group. | PRD, PRD, "Requirements". | FR-41 to FR-44. |
| "(CR-10)" on NFR-13. | PRD, NFR-13. | NFR-13. |
| "(CR-13)" on the conversations group. | PRD, PRD, "Requirements". | FR-45 to FR-47. |
| "(CR-22)" on the pages server group. | PRD, PRD, "Requirements". | FR-48 to FR-57. |
| "(CR-22)" on NFR-14. | PRD, NFR-14. | NFR-14. |
| "(CR-22)" on NFR-15. | PRD, NFR-15. | NFR-15. |
| "(CR-22)" on NFR-16. | PRD, NFR-16. | NFR-16. |
| "(CR-22)" on the background pages process. | PRD, NFR-1. | NFR-1. |
| Test file names in each "Check:" note. | PRD, "Requirements". | LLD.md. |
| NFR-10's rule written once and its interface snapshot. | PRD, NFR-10. | HLD.md. |
| NFR-13's check runs without a shell. | PRD, NFR-13. | HLD.md. |
| NFR-14's mechanism, only the process's own timer stops it. | PRD, NFR-14. | HLD.md. |
| NFR-16's restart timer cost. | PRD, NFR-16. | HLD.md, NFR-16. |
| The audit log file and the setting that turns it off. | PRD, FR-23. | FR-23, LLD.md. |
| The port setting. | PRD, FR-48. | FR-48, LLD.md. |
| The pages field in a result. | PRD, FR-56. | FR-56, LLD.md. |
| The classification file. | PRD, FR-26. | FR-26. |
| Code review of diffs is out of scope. | PRD, "Out of scope". | "Out of scope". |
| Materializing on the GitHub channel is out of scope. | PRD, "Out of scope". | "Out of scope". |
| Accounts, hosting and notifications are out of scope. | PRD, "Out of scope". | "Out of scope". |
| FR-9, the decision search tool. | PRD, "Out of scope". | Retired. |
| The out of scope section. | PRD, "Out of scope". | "Out of scope". |
| The assumptions section. | PRD, "Assumptions and open questions". | "Assumptions and open questions". |
| Hoop is installed from source, and publishing to npm is open. | PRD, "Assumptions and open questions". | "Assumptions and open questions", "Out of scope". |
| NFR-17. | CR-31 PRD. | NFR-17. |
| NFR-18. | CR-31 PRD. | NFR-18. |
| NFR-19. | CR-31 PRD. | NFR-19. |
| NFR-20. | CR-31 PRD. | NFR-20. |
| NFR-21. | CR-31 PRD. | NFR-21. |
| FR-31. | CR-31 PRD. | FR-31. |
| FR-3. | CR-31 PRD. | FR-3. |
| FR-35. | CR-31 PRD. | FR-35. |
| NFR-4. | CR-31 PRD. | NFR-4. |
| FR-58. | CR-31 PRD. | FR-58. |
| FR-59. | CR-31 PRD. | FR-59. |
| FR-141. | CR-31 PRD. | FR-141. |
| FR-60. | CR-31 PRD. | FR-60. |
| FR-61. | CR-31 PRD. | FR-61. |
| FR-62. | CR-31 PRD. | FR-62. |
| FR-63. | CR-31 PRD. | FR-63. |
| FR-64. | CR-31 PRD. | FR-64. |
| FR-65. | CR-31 PRD. | FR-65. |
| FR-66. | CR-31 PRD. | FR-66. |
| FR-67. | CR-31 PRD. | FR-67. |
| FR-68. | CR-31 PRD. | FR-68. |
| FR-69. | CR-31 PRD. | FR-69. |
| FR-70. | CR-31 PRD. | FR-70. |
| FR-71. | CR-31 PRD. | FR-71. |
| FR-72. | CR-31 PRD. | FR-72. |
| FR-73. | CR-31 PRD. | FR-73. |
| FR-74. | CR-31 PRD. | FR-74. |
| FR-75. | CR-31 PRD. | FR-75. |
| FR-76. | CR-31 PRD. | FR-76. |
| FR-77. | CR-31 PRD. | FR-77. |
| FR-78. | CR-31 PRD. | FR-78. |
| FR-142. | CR-31 PRD. | FR-142. |
| FR-79. | CR-31 PRD. | FR-79. |
| FR-80. | CR-31 PRD. | FR-80. |
| FR-81. | CR-31 PRD. | FR-81. |
| FR-82. | CR-31 PRD. | FR-82. |
| FR-83. | CR-31 PRD. | FR-83. |
| FR-143. | CR-31 PRD. | FR-143. |
| FR-84. | CR-31 PRD. | FR-84. |
| FR-144. | CR-31 PRD. | FR-144. |
| FR-85. | CR-31 PRD. | FR-85. |
| FR-86. | CR-31 PRD. | FR-86. |
| FR-87. | CR-31 PRD. | FR-87. |
| FR-145. | CR-31 PRD. | FR-145. |
| FR-88. | CR-31 PRD. | FR-88. |
| FR-89. | CR-31 PRD. | FR-89. |
| FR-90. | CR-31 PRD. | FR-90. |
| FR-91. | CR-31 PRD. | FR-91. |
| FR-92. | CR-31 PRD. | FR-92. |
| FR-93. | CR-31 PRD. | FR-93. |
| FR-94. | CR-31 PRD. | FR-94. |
| FR-95. | CR-31 PRD. | FR-95. |
| FR-96. | CR-31 PRD. | FR-96. |
| FR-97. | CR-31 PRD. | FR-97. |
| FR-98. | CR-31 PRD. | FR-98. |
| FR-99. | CR-31 PRD. | FR-99 to FR-117, NFR-22 to NFR-24. |
| FR-118. | CR-31 PRD. | FR-118. |
| FR-119. | CR-31 PRD. | FR-119. |
| FR-120. | CR-31 PRD. | FR-120. |
| FR-121. | CR-31 PRD. | FR-121. |
| FR-122. | CR-31 PRD. | FR-122. |
| FR-123. | CR-31 PRD. | FR-123. |
| FR-124. | CR-31 PRD. | FR-124. |
| FR-125. | CR-31 PRD. | FR-125. |
| FR-126. | CR-31 PRD. | FR-126. |
| FR-127. | CR-31 PRD. | FR-127. |
| FR-128. | CR-31 PRD. | FR-128. |
| FR-129. | CR-31 PRD. | FR-129. |
| FR-130. | CR-31 PRD. | FR-130. |
| FR-131. | CR-31 PRD. | FR-131. |
| FR-132. | CR-31 PRD. | FR-132. |
| FR-133. | CR-31 PRD. | FR-133. |
| FR-134. | CR-31 PRD. | FR-134. |
| FR-135. | CR-31 PRD. | FR-135. |
| FR-136. | CR-31 PRD. | FR-136. |
| FR-137. | CR-31 PRD. | FR-137. |
| FR-138. | CR-31 PRD. | FR-138. |
| FR-139. | CR-31 PRD. | FR-139. |
| FR-140. | CR-31 PRD. | FR-140. |
| CR-31 problem. | CR-31 PRD, "Problem". | "Problem". |
| CR-31 success criteria. | CR-31 PRD, "Success criteria". | "Success criteria". |
| CR-31 personas. | CR-31 PRD, "Target personas". | "Target personas". |
| CR-31 changes to current behavior. | CR-31 PRD, "Changes to current behavior". | FR-1, FR-3, FR-4, FR-7, FR-16, FR-19, FR-20, FR-25, FR-30, FR-31, FR-35, NFR-1, NFR-4, NFR-5, FR-78, FR-125. |
| CR-31 out of scope lines that last. | CR-31 PRD, "Out of scope". | "Out of scope". |
| CR-31 out of scope lines that applied only to it (Plannotator ideas, CR-30 comparison states). | CR-31 PRD, "Out of scope". | "Assumptions and open questions". |
| CR-31 assumptions that last. | CR-31 PRD, "Assumptions and open questions". | "Assumptions and open questions". |
| CR-30 NFR-1. | CR-30 PRD. | NFR-22. |
| CR-30 NFR-2. | CR-30 PRD. | NFR-23. |
| CR-30 NFR-3. | CR-30 PRD. | NFR-24. |
| CR-30 FR-1. | CR-30 PRD. | FR-99. |
| CR-30 FR-2. | CR-30 PRD. | FR-100. |
| CR-30 FR-3. | CR-30 PRD. | FR-101. |
| CR-30 FR-4. | CR-30 PRD. | FR-102. |
| CR-30 FR-5. | CR-30 PRD. | FR-103. |
| CR-30 FR-6. | CR-30 PRD. | FR-104. |
| CR-30 FR-7. | CR-30 PRD. | FR-105. |
| CR-30 FR-8. | CR-30 PRD. | FR-106. |
| CR-30 FR-9. | CR-30 PRD. | FR-107. |
| CR-30 FR-10. | CR-30 PRD. | FR-108. |
| CR-30 FR-11. | CR-30 PRD. | FR-109. |
| CR-30 FR-12. | CR-30 PRD. | FR-110. |
| CR-30 FR-13. | CR-30 PRD. | FR-111. |
| CR-30 FR-14. | CR-30 PRD. | FR-112. |
| CR-30 FR-15. | CR-30 PRD. | FR-113. |
| CR-30 FR-16. | CR-30 PRD. | FR-114. |
| CR-30 FR-17. | CR-30 PRD. | FR-115. |
| CR-30 FR-18. | CR-30 PRD. | FR-116. |
| CR-30 FR-19. | CR-30 PRD. | FR-117. |
| CR-30's rule that the checker skips a change's request file. | CR-30 PRD, "Edge cases and error handling". | "Edge cases and error handling". |
| CR-30 problem. | CR-30 PRD, "Problem". | "Problem". |
| CR-30 success criteria. | CR-30 PRD, "Success criteria". | "Success criteria". |
| CR-30 personas. | CR-30 PRD, "Target personas". | "Target personas". |
| CR-30 retirements. | CR-30 PRD, "Changes to current behavior". | "Retired requirements". |
| CR-30 mechanisms moved out of NFR-13, NFR-14 and NFR-16. | CR-30 PRD, "Changes to current behavior". | NFR-13, NFR-14, NFR-16, HLD.md. |
| CR-30 out of scope: past change documents. | CR-30 PRD, "Out of scope". | "Out of scope". |
| CR-30 assumptions. | CR-30 PRD, "Assumptions and open questions". | "Assumptions and open questions". |
| The status line listed the folded changes CR-2, CR-3, CR-8, CR-9, CR-10, CR-13 and CR-22. | HLD, status line. | HLD.md, "hoop HLD". |
| The context diagram marked the check runner with CR-10. | HLD, "Context" diagram. | FR-41 to FR-44, HLD.md, "Context and scope". |
| The markdown component records each source line's place (CR-10). | HLD, "Design", Markdown row. | FR-42, FR-44, HLD.md, "Architecture". |
| The store keeps check outcomes (CR-10). | HLD, "Design", Store row. | FR-42, HLD.md, "Architecture". |
| The review rules decide whether a review can change and find a thread (CR-8). | HLD, "Design", Review rules row. | FR-31, NFR-4, HLD.md, "Architecture". |
| The review rules give each review its status key (CR-9). | HLD, "Design", Review rules row. | FR-33, FR-34, HLD.md, "Architecture". |
| The materializer turns suggestions and accepted edits into revisions (CR-8). | HLD, "Design", Materializer row. | FR-18, FR-21, HLD.md, "Architecture". |
| The page frame and status set (CR-9). | HLD, "Design", Page frame row. | FR-32, FR-33, FR-34, HLD.md, "Architecture". |
| One rule decides each line's kind (CR-9). | HLD, "Design", Line kinds row. | FR-35, HLD.md, "Architecture". |
| Resolved conversations collapse and one mode hides every comment (CR-13). | HLD, "Design", Conversations and hidden mode row. | FR-45 to FR-47, HLD.md, "Architecture". |
| The check runner runs the allowed check command (CR-10). | HLD, "Design", Check runner row. | FR-41 to FR-43, HLD.md, "Architecture". |
| The findings panel shows the latest checked revision's findings (CR-10). | HLD, "Design", Findings panel row. | FR-44, HLD.md, "Architecture". |
| The line renderer maps shown characters to source (CR-9). | HLD, "Design", Line renderer row. | FR-35 to FR-37, HLD.md, "Architecture". |
| `hoop audit` reports check counts (CR-10). | HLD, "Design", Wait, audit, CLI row. | FR-24, HLD.md, "Cross-cutting concerns". |
| The shared helpers give each folder's repository identity (CR-9). | HLD, "Design", Shared helpers row. | FR-32, FR-53, HLD.md, "Architecture". |
| The change request and tracker MCP tools were added by CR-3. | HLD, "Interfaces and contracts". | FR-25 to FR-31, FR-58, FR-59, HLD.md, "Data and interfaces". |
| The tracker HTTP routes were added by CR-3. | HLD, "Interfaces and contracts". | FR-30, HLD.md, "Data and interfaces". |
| The check results, config files and audit event were added by CR-10. | HLD, "Interfaces and contracts". | FR-41 to FR-44, HLD.md, "Data and interfaces". |
| The repository identity route and the status fields were added by CR-9. | HLD, "Interfaces and contracts". | FR-32, FR-33, FR-35, HLD.md, "Data and interfaces". |
| The change and tracker files were added by CR-3. | HLD, "Interfaces and contracts". | FR-25, FR-26, FR-29, HLD.md, "Data and interfaces". |
| D-12 keeps exact spacing in titled documents (CR-2). | HLD, "Decisions", D-12. | FR-17, HLD.md, "Alternatives and decisions". |
| D-12 named documents stored before CR-2. | HLD, "Decisions", D-12. | FR-17, HLD.md, "Alternatives and decisions". |
| D-13 makes the repository the source of truth for changes and trackers (CR-3). | HLD, "Decisions", D-13. | FR-25, FR-29, HLD.md, "Alternatives and decisions". |
| D-14 puts the gates in hoop (CR-3). | HLD, "Decisions", D-14. | FR-27, FR-28, HLD.md, "Alternatives and decisions". |
| D-15 computes staleness from approval times (CR-3). | HLD, "Decisions", D-15. | FR-27, HLD.md, "Alternatives and decisions". |
| D-16 mirrors the agent tools as terminal commands (CR-3). | HLD, "Decisions", D-16. | FR-31, HLD.md, "Alternatives and decisions". |
| D-17 records classification corrections in the repository (CR-3). | HLD, "Decisions", D-17. | FR-26, HLD.md, "Alternatives and decisions". |
| D-18 keeps the core as the single entry point (CR-8). | HLD, "Decisions", D-18. | FR-31, NFR-4, HLD.md, "Alternatives and decisions". |
| D-19 maps formatted lines to source offsets (CR-9). | HLD, "Decisions", D-19. | FR-36, FR-37, HLD.md, "Alternatives and decisions". |
| D-20 decides each line's kind once (CR-9). | HLD, "Decisions", D-20. | FR-35, HLD.md, "Alternatives and decisions". |
| D-21 gives each review a status key and a repository identity (CR-9). | HLD, "Decisions", D-21. | FR-32, FR-33, HLD.md, "Alternatives and decisions". |
| D-22 uses inline icons and system fonts (CR-9). | HLD, "Decisions", D-22. | NFR-11, HLD.md, "Alternatives and decisions". |
| D-23 shows an automatic TL;DR once (CR-9). | HLD, "Decisions", D-23. | FR-39, HLD.md, "Alternatives and decisions". |
| D-24 has the project's command hold the writing rules (CR-10). | HLD, "Decisions", D-24. | FR-41, FR-43, HLD.md, "Alternatives and decisions". |
| D-25 runs a check only when the user's own config allows it (CR-10). | HLD, "Decisions", D-25. | FR-41, HLD.md, "Alternatives and decisions". |
| D-26 never blocks a submission on a check (CR-10). | HLD, "Decisions", D-26. | FR-43, HLD.md, "Alternatives and decisions". |
| D-27 keeps open threads and hidden mode in memory only (CR-13). | HLD, "Decisions", D-27. | FR-46, HLD.md, "Alternatives and decisions". |
| D-28 hides comments by one page mode keyed on a marker (CR-13). | HLD, "Decisions", D-28. | FR-46, HLD.md, "Alternatives and decisions". |
| The renderer escapes markup and limits links (CR-9). | HLD, "Risks". | FR-35, HLD.md, "Traceability and risks". |
| A comment element without the marker stays visible (CR-13). | HLD, "Risks". | FR-46, HLD.md, "Traceability and risks". |
| A cloned repository's config could run code on submit (CR-10). | HLD, "Risks". | FR-41, HLD.md, "Traceability and risks". |
| An allow entry binds the command, and a slow check adds time (CR-10). | HLD, "Risks". | FR-41, FR-43, HLD.md, "Traceability and risks". |
| A selection could map to the wrong source text (CR-9). | HLD, "Risks". | FR-36, HLD.md, "Traceability and risks". |
| The list of changes folded into the LLD (CR-2, CR-3, CR-8, CR-9, CR-10, CR-13 and CR-22). | LLD, status line. | LLD.md, "Test plan". |
| Since CR-8, the core delegates apply, propose, position and decide to the materializer. | LLD, "Core (`src/hoop.ts`)". | LLD.md, "Core (`src/hoop.ts`)", "Materializer (`src/materialize.ts`)", FR-18, FR-20, FR-21. |
| The review rules module came from CR-8. | LLD, "Review rules (`src/rules.ts`, CR-8)". | LLD.md, "Review rules (`src/rules.ts`)", FR-7, FR-31, FR-81. |
| The status key came from CR-9. | LLD, "Review rules (`src/rules.ts`, CR-8)". | LLD.md, "Review rules (`src/rules.ts`)", FR-33. |
| The materializer came from CR-8. | LLD, "Materializer (`src/materialize.ts`, CR-8)". | LLD.md, "Materializer (`src/materialize.ts`)", FR-18, FR-20, FR-21. |
| Pages and line rendering came from CR-9. | LLD, "Pages and line rendering (`web/*`, CR-9)". | LLD.md, "Pages and line rendering (`web/*`)", FR-32 to FR-37. |
| Document checks came from CR-10. | LLD, "Document checks (`src/checks.ts`, `web/checks.js`, CR-10)". | LLD.md, "Document checks (`src/checks.ts`, `src/allow.ts`, `web/checks.js`)", FR-41 to FR-44. |
| Conversations and hidden comments came from CR-13. | LLD, "Conversations and hidden comments (`web/review.js`, CR-13)". | LLD.md, "Conversations and hidden comments (`web/review.js`)", FR-45 to FR-47. |
| The change registry came from CR-3. | LLD, "Change registry (`src/changes.ts`, CR-3)". | LLD.md, "Change registry (`src/changes.ts`)", FR-25, FR-26, FR-28. |
| The review sequencer came from CR-3. | LLD, "Review sequencer (`src/sequence.ts`, CR-3)". | LLD.md, "Review sequencer (`src/sequence.ts`)", FR-27, FR-28, NFR-8. |
| The tracker service came from CR-3. | LLD, "Tracker service (`src/tracker.ts`, CR-3)". | LLD.md, "Tracker service (`src/tracker.ts`)", FR-29, NFR-9. |
| Operations and the CLI came from CR-3. | LLD, "Operations and CLI (`src/ops.ts`, `src/cli.ts`, CR-3)". | LLD.md, "Operations, project settings and the MCP server (`src/ops.ts`, `src/project.ts`, `src/mcp.ts`)", FR-31. |
| The tracker pages came from CR-3. | LLD, "Tracker pages (`web/tree.js`, `web/tracker.js`, CR-3)". | LLD.md, "Tracker pages (`web/tree.js`, `web/tracker.js`)", FR-30. |
| Test titles in the pages and sessions tests use older numbers. | LLD, "Test plan". | LLD.md, "Test plan", FR-48 to FR-57, NFR-14 to NFR-16. |
| NFR-10's tests, the rules and the interface snapshot. | LLD, "Test plan". | FR-31, NFR-4. |

## Retired

- FR-9: The decision search tool retired earlier. Its text is in the out of scope list.
- NFR-10: It stated how the code is built. Its text moved to the HLD's decisions, which point to FR-31 and NFR-4.
