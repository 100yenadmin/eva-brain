# Media Evidence Architecture

**Status:** Draft upstream architecture note
**Audience:** downstream implementers, upstream GBrain maintainers
**Updated:** 2026-05-01

## Why this exists

GBrain already has strong content ingestion patterns for transcripts, documents, and searchable pages. What it does not yet have is a runtime-level architecture for treating uploaded or linked media as first-class evidence.

This document frames that gap in upstream-friendly terms:

- **media artifacts** as canonical source objects
- **media segments** as addressable subranges inside those artifacts
- **media evidence** as extracted or derived signals tied back to artifact + segment provenance
- **media resolvers** as the extraction boundary
- **match reasons** as the retrieval explanation surface

The intent is to let a downstream fork ship a practical MVP now without locking upstream into fork-local branding, storage choices, or provider choices.

## Problem statement

Today, GBrain can already ingest content into searchable pages, raw data, and files. That gets us part of the way for PDFs, screenshots, videos, and audio. But media support remains mostly page-centric rather than artifact-centric:

- there is no canonical runtime shape for an uploaded image, PDF, audio file, or video
- there is no segment-level retrieval model for pages, timestamps, regions, or clips
- extraction pipelines are implicit and tool-specific rather than exposed as stable resolver contracts
- search can return relevant text, but not yet a principled explanation of *which media region matched and why*

That makes fork-local MVPs possible, but it leaves upstream without a clear abstraction seam.

## Design goals

1. **Keep first user value fast.** A fork should be able to ship useful media recall without a large runtime rewrite.
2. **Define canonical nouns early.** Upstream should review stable concepts, not implementation trivia.
3. **Preserve provenance.** Every extracted claim should point back to the original artifact and, where possible, the exact segment.
4. **Remain backend-agnostic.** No required vector database, OCR provider, caption provider, or storage vendor.
5. **Fit existing GBrain primitives.** Media should feed pages, chunks, raw data, links, and search instead of replacing them.
6. **Support explainable retrieval.** Results should expose match reasons, not just scores.

## Core concepts

### 1. Media artifact

A **media artifact** is the canonical record for a binary or externally hosted source item.

Examples:
- an uploaded screenshot
- a PDF attachment
- an MP3 meeting recording
- a local video file
- a hosted YouTube URL once normalized into a tracked source object

A media artifact answers:
- where the original came from
- what type of media it is
- how it is stored or referenced
- what downstream extraction jobs have been run against it

Suggested minimum shape:

```ts
interface MediaArtifact {
  id: string;
  kind: 'image' | 'pdf' | 'audio' | 'video' | 'document';
  sourceUrl?: string;
  fileId?: string;              // if backed by existing files table/storage layer
  mimeType?: string;
  title?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}
```

A downstream MVP can materialize this concept implicitly via existing `files` + page frontmatter + `raw_data`. Upstream does not need to require a new table on day one, but the concept should be explicit.

### 2. Media segment

A **media segment** is an addressable subrange within a media artifact.

Examples:
- page 7 of a PDF
- timestamp 00:12:34–00:12:51 of a video
- a sampled keyframe at 00:05:10
- a rectangular crop/region inside an image
- a paragraph span in extracted OCR text

Segments are how retrieval becomes precise instead of treating the whole file as one blob.

Suggested minimum shape:

```ts
interface MediaSegment {
  id: string;
  artifactId: string;
  segmentType: 'page' | 'time_range' | 'frame' | 'region' | 'text_span';
  locator: Record<string, unknown>; // page number, timecode range, bbox, offsets
  textPreview?: string;
  metadata?: Record<string, unknown>;
}
```

### 3. Media evidence

**Media evidence** is any extracted or derived signal attached to either an artifact or a segment.

Examples:
- OCR text from a PDF page
- a caption generated for an image
- ASR transcript from an audio span
- labels/entities detected on a frame
- an embedding vector generated from a segment
- a human-authored note tied to a specific screenshot region

This is the bridge from raw media into GBrain’s existing searchable model.

Suggested minimum shape:

```ts
interface MediaEvidence {
  id: string;
  artifactId: string;
  segmentId?: string;
  evidenceType:
    | 'ocr_text'
    | 'caption'
    | 'transcript'
    | 'summary'
    | 'entity'
    | 'embedding'
    | 'metadata';
  content?: string;
  rawDataRef?: string;
  resolverId?: string;
  confidence?: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}
```

### 4. Media resolver

A **media resolver** is the runtime boundary that turns a media artifact or media segment into media evidence.

Examples:
- image OCR resolver
- PDF page text resolver
- audio transcription resolver
- video keyframe sampling resolver
- captioning resolver
- embedding resolver for image/text retrieval

This fits the existing Knowledge Runtime direction: resolvers should be the unit of extraction, substitution, testing, and provenance.

Resolver properties should include:
- declared input/output schemas
- deterministic vs paid/provider-backed execution
- provenance metadata for every result
- optional fallback behavior

This keeps extraction logic composable and upstreamable even if a fork starts with cloud-assisted tooling.

### 5. Match reason

A **match reason** is the user-visible explanation for why a media result appeared in search.

Examples:
- “OCR text on PDF page 4 matched ‘pricing tiers’”
- “Video transcript at 00:01:24 mentions ‘login screen error’”
- “Image caption and visual embedding both matched ‘whiteboard architecture’”

This should be treated as a first-class retrieval output, not an afterthought in UI copy. Media search without match reasons feels opaque and brittle.

## Architecture: how media fits GBrain

The recommended upstream shape is additive, not disruptive.

### Existing GBrain primitives to reuse

GBrain already has strong building blocks:

- `files` for binary attachment storage
- `raw_data` for sidecar provenance
- pages + chunks for searchable text views
- hybrid search for keyword/vector retrieval
- resolver-oriented runtime direction in the Knowledge Runtime design

The key idea is:

> media evidence should feed existing graph/page/search primitives, while preserving a canonical artifact/segment/evidence lineage underneath.

### Data flow

```text
input file or URL
  -> normalize into media artifact
  -> produce one or more media segments
  -> run media resolvers over artifact and/or segments
  -> emit media evidence records
  -> materialize searchable text/views into normal pages or chunks
  -> expose media-aware search results with match reasons
```

### Search model

Search should be able to combine:
- artifact metadata
- extracted OCR/caption/transcript text
- existing page/chunk search
- optional multimodal embeddings
- filters by media type
- match reasons derived from the winning evidence

This preserves current search investments while allowing more precise media retrieval later.

## Fork-local MVP vs upstreamable seam

### Fork-local MVP (acceptable now)

A downstream fork can deliver value quickly by using today’s primitives:

- store original binary via the existing `files` layer
- create or update a normal page for the media item
- store OCR/caption/transcript/provider payloads in `raw_data`
- materialize extracted text into searchable page/chunk content
- optionally attach lightweight frontmatter describing artifact kind and locators

This MVP is intentionally pragmatic:
- it may collapse artifact/evidence/page concepts together
- it may rely on current tools for OCR/PDF/video frame extraction
- it may skip a dedicated schema for segments at first
- it may treat match reasons as derived display logic rather than stored records

That is fine for a fork.

### Upstreamable seam (what should remain stable)

Even if the fork starts pragmatically, upstream should standardize the seam around:

- canonical **media artifact** identity
- optional **media segment** identity and locators
- **media resolver** contracts for extraction
- **media evidence** as the provenance-bearing derived layer
- **match reasons** as part of retrieval output

This is the level of abstraction likely to survive backend churn.

## Minimal upstream change surface

A realistic upstream contribution should stay narrow.

### Candidate core additions

1. **Canonical metadata shape** for media artifacts in frontmatter / operations / API output.
2. **Resolver interfaces** for media extraction, consistent with the broader resolver SDK direction.
3. **Optional locator-aware evidence records** stored either in a dedicated table later or through a transitional raw-data-backed representation.
4. **Search response extensions** for media type, locator, preview hint, and match reason.
5. **No mandatory provider/backend dependency.** OCR, transcription, and vector retrieval remain pluggable.

### Explicit non-goals for upstream v1

- no mandatory LanceDB/Qdrant dependency
- no forced object-store redesign
- no provider-specific resolver in the abstraction itself
- no giant UI rewrite requirement
- no fork-only brand language

## Gary / GBrain upstream pitch

A concise pitch for Gary should sound like this:

> GBrain already treats media ingestion as first-class at the skill layer. This proposal makes media ingestion real at the runtime layer by adding canonical media artifacts, resolver-based extraction, and searchable segment-level evidence that feeds the existing graph/page/search model.

Why this pitch works:
- it extends current architecture instead of replacing it
- it fits the Knowledge Runtime direction
- it preserves the thin-harness / fat-skills philosophy
- it leaves storage and model/provider choices open
- it improves provenance and search quality for screenshots, PDFs, audio, and video

## Recommended implementation order

### Phase A — downstream MVP

- treat uploads/URLs as media-backed pages
- preserve original binaries with `files`
- store extraction payloads in `raw_data`
- index extracted text into ordinary search
- return basic media-aware result cards

### Phase B — extraction seam cleanup

- factor OCR/caption/transcript steps behind media resolver interfaces
- normalize artifact metadata and segment locators
- emit structured match reasons

### Phase C — richer evidence model

- make segment-level evidence a clearer runtime concept
- add optional multimodal embedding backends
- support page/time-range/frame scoped retrieval and related-item lookup

### Phase D — upstream formalization

- stabilize artifact/evidence contracts
- land minimal search/result API changes
- ship docs/examples without coupling upstream to any single backend

## Open questions

1. Should artifact and evidence live as first-class tables immediately, or begin as an operations/frontmatter contract backed by existing tables?
2. What is the smallest search API change needed to carry locator + match-reason fields cleanly?
3. Should segment locators be normalized into typed fields early, or remain flexible JSON until real usage stabilizes?
4. Which built-in media resolvers, if any, are worth shipping in core vs documented as recipes/plugins?

## Bottom line

The fork should move now, but the vocabulary should already be upstream-friendly.

The winning pattern is:
- **fork-local implementation pragmatism**
- paired with **upstream-stable runtime nouns**

If we get that right, today’s MVP becomes tomorrow’s small, coherent upstream contribution instead of a throwaway fork subsystem.
