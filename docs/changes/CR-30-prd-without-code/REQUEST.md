why is the PRD containing references to the code. please update all relevant skills to ensure PRD doesnt 



top 10 things a software PRD should never have

Prescribed Implementation Details: Avoid dictating specific tech stacks, database schemas, or code architecture; focus on the what and why, leaving the how to engineering.

Vague or Subjective Acceptance Criteria: Leave no room for ambiguous terms like "fast," "user-friendly," or "intuitive"—replace them with measurable metrics (e.g., "p99 response time < 200ms").

Unbounded or Unscoped Feature Sets: Exclude feature creep without clear boundaries or defined non-goals.

Unvalidated Assumptions Presented as Facts: Avoid asserting user needs or market demands without supporting telemetry, customer feedback, or research data.

Hardcoded Dates and Fixed Commitments: Exclude rigid deadlines; timeline scheduling belongs in project management tools, not functional specs.

High-Fidelity UI Lock-in: Avoid embedding finalized pixel-perfect UI designs that strip design teams of UX exploration and iteration.

Missing Out-of-Scope Definitions: Never omit a dedicated "Out of Scope" section to prevent continuous boundary expansion.

Unlinked Dependencies and Blockers: Exclude orphaned requirements that depend on unlisted upstream systems or API contracts.

Solutions Without Problem Statements: Avoid defining features without clearly stating the underlying customer problem or business objective.

Untestable Edge Cases: Exclude blanket or unquantifiable statements like "system must never fail" in place of concrete error-handling expectations.


template


1. Feature Overview & ObjectivesDefine the strategic "why" before diving into the "how." This grounds the engineering and design teams in the user value.Section ContainsShould NOT ContainProblem Statement: The specific user friction being solved.Success Criteria: How we know the feature worked (e.g., adoption rate, task completion time).Target Persona: Who is using this specific feature.❌ Business-level revenue projections.❌ Marketing rollout plans.❌ Technical telemetry specs or logging frameworks.2. User <-> Software Interactions & Behavioral FlowsThis is the core of the PRD, detailing exactly how the user moves through the feature from start to finish.Section ContainsShould NOT ContainEntry Points: How the user discovers and accesses the feature.Step-by-Step User Journey: The exact sequence of actions (clicks, swipes, keyboard inputs).Exit Points & Handoffs: Where the user lands after task completion or cancellation.❌ API endpoint definitions.❌ Database schema changes or storage engines.❌ System latency SLAs.3. UI States & TransitionsA comprehensive breakdown of what the interface looks and feels like at every stage of the interaction lifecycle.Section ContainsShould NOT ContainIdeal State: The UI when data is populated and the user is on the happy path.Empty States: What the UI shows on first use or when no data exists.Loading & Transitional States: Skeletons, spinners, and micro-animations during data fetches.Partial States: How the UI degrades gracefully if only some data is available.❌ Hardcoded CSS, exact hex colors, or pixel measurements (leave to design).❌ Underlying rendering architecture.4. Edge Cases & Error HandlingAnticipating where the user journey can break and defining the exact recovery paths.Section ContainsShould NOT ContainDestructive Actions: Confirmation dialogues and undo mechanics for deletions.Offline/Interrupted States: UI behavior when the network drops mid-interaction.Validation Errors: Specific inline error messages for invalid inputs.Permission/State Conflicts: What happens if two users edit simultaneously, or a user lacks access.❌ Server-side retry logic algorithms.❌ Infrastructure failure routing.❌ Backend error code dictionaries (focus on user-facing strings).5. Explicitly Out of ScopeFencing the feature to prevent scope creep and keep the team focused on the immediate user interactions.Section ContainsShould NOT ContainDeferred Features: Specific user interactions saved for v2.Unsupported Platforms: E.g., "Mobile web layout is out of scope for this release."Architecture Exclusions: Explicitly stating that latency optimizations, telemetry pipelines, and infrastructure scaling are decoupled from this release.

capture the above in relevant skills. rewrite existing PRD if required. - ensure no information is lost.
