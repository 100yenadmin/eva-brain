---
name: retrieval-reflex
version: 0.1.0
description: When/what to retrieve - open the brain page for a salient entity before answering from memory.
triggers:
  - "retrieval reflex"
  - "salient entity pointer"
  - "open brain page before answering"
mutating: false
writes_pages: false
writes_to: []
tools: [get_page, query, graph, backlinks]
---

# Retrieval Reflex - retrieve on demand, when an entity is salient

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md)

A person doesn't bulk-load their whole address book into working memory. They
retrieve on demand, when an entity becomes salient, use it, and drop it.
Encode that reflex. The brain probably has the data - if a name is salient and
you haven't opened its page, open it before you answer.

## Trigger policy - WHEN to retrieve

Retrieve when ANY of these holds AND the page isn't already loaded in context:

- An entity (person / company / project / deal / place) is the subject of
  the message, or a decision/judgment about it is being made, or the exchange is
  substantive / relational / emotional about it.
- A brain-page pointer appeared in context this turn (the deterministic
  layer told you the page exists) - open it before relying on details.
- A name or term appears that you don't recognize and that looks notable -
  do a quick resolve (the human reflex).
- You're about to assert a non-trivial detail about an entity (attribution,
  status, history) - verify against the brain first. Say "let me check", not a guess.

Skip trivial passing mentions, logistics pings, and anything already loaded.
Judgment first - retrieve when it changes the quality of the reply, not reflexively.

## Retrieval spec - WHAT to pull, and when to stop

Escalate only as far as the task needs:

1. Pointer / metadata. If a pointer is already in context (slug + one-line
   summary), and the task only needs identity, stop there.
2. Full page. When the entity is the subject or details matter, open it:
   `get_page <slug>` (MCP) - read the page before relying on specifics.
3. Linked neighbors. Only when relationship context is needed, pull
   `graph` / `backlinks` for the slug.

Resolve only the name(s) the current task needs, use them, drop them. No
bulk-loading the inner circle.

## The failure this prevents

If you've discussed a named person for more than a message without opening their
page, open it now. The write side captures everything; the read side only helps
if you actually look.

See also: `skills/query/SKILL.md` (search the brain), `skills/brain-ops/SKILL.md`.

## Contract

- Open only the current task's salient brain page(s), then answer from the retrieved page context.
- Prefer `get_page` when a slug/pointer is already known; use `query` only to resolve an unknown notable name or term.
- Pull `graph` or `backlinks` only when relationship context is needed for the answer.
- Keep the operation read-only: this skill retrieves context but does not write pages, tags, edges, receipts, or facts.

## Anti-Patterns

- Do not bulk-load every possibly related person, company, or project page.
- Do not skip retrieval when a pointer was explicitly supplied and the answer depends on page details.
- Do not treat a passing mention as a reason to search if the detail would not change the response.
- Do not invent relationship, status, attribution, or history details from memory when the brain can verify them.

## Output Format

When retrieval changes the answer, briefly ground the response in what was opened:

```text
Checked: <slug or page title>
Answer: <concise answer using the retrieved context>
```

If retrieval is skipped, continue normally without adding a ritual note.
