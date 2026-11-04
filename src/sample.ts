// The sample review: a short document to try the review page on before Claude sends a real one.
// `hoop init` opens it at the end, and Home offers it while it lists no reviews. It belongs to the
// person, as a file opened with `hoop open` does, so no session is told what they write on it.

/** The sample's markdown: a line to comment on, words to suggest a change to, and a Question section. */
export const SAMPLE_MARKDOWN = `# Sample review: plan the team offsite

*A sample to try hoop on: no Claude session is waiting on it*

This is a sample, so you can try the review page before Claude sends you a real document. Comment on a line, suggest a change and answer the question; close the sample when you're done.

## Try it

- Press + beside any line to comment on it.
- Select a few words to comment on just those, or to suggest new wording for them.
- Pick an answer in the Question section below.
- When you're done, press Approve or Request changes at the top, or Close to put the sample away.

## The plan

The team meets for two days in Lisbon. The first day is for planning next quarter; the second is a walk along the river and a long dinner.

Everyone books their own travel by the end of the month, and the team pays for it.

## Question: When should the offsite be?

- A. In March, before the busy season (recommended)
- B. In May, when the weather is warmer
- C. In September, after the summer holidays
`;
