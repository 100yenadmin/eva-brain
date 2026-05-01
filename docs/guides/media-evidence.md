# Media Evidence

## Goal
Make screenshots, PDFs, audio, and video searchable in GBrain through canonical media artifacts, resolver-based extraction, and evidence-backed match reasons.

## What the User Gets
Without this: media is attached or summarized, but retrieval is fuzzy and provenance is weak. You may remember that a screenshot or PDF mattered, but not which page, frame, or transcript span matched the query. With this: media can become a first-class searchable source with exact artifact lineage, segment-level evidence, and explainable search results.

## Core model

### Media artifact
The original source object: image, PDF, audio file, video file, or normalized external media URL.

### Media segment
An addressable slice of the artifact: PDF page, transcript span, video time range, frame, or image region.

### Media evidence
Derived signal linked back to artifact and segment provenance: OCR text, transcript, caption, summary, entity extraction, embeddings, metadata.

### Media resolver
A runtime component that transforms an artifact or segment into evidence.

### Match reason
The explanation shown to the user for why a result matched.

## Recommended flow

```text
file or URL
  -> media artifact
  -> media segments (optional at MVP stage)
  -> media resolvers
  -> media evidence
  -> searchable page/chunk materialization
  -> result card with match reason
```

## Fast fork-local MVP

If you need user value immediately, keep it simple:

1. Store the original binary with the existing `files` layer.
2. Create a normal page for the media item.
3. Save OCR/caption/transcript payloads in `raw_data`.
4. Materialize extracted text into searchable content.
5. Return media-aware results with a locator and match reason when available.

This is intentionally pragmatic. It does **not** require a new vector backend or a full schema redesign.

## Upstream-friendly seam

Keep the runtime vocabulary stable even if the implementation starts simple:

- canonical media artifact identity
- optional media segment identity + locator
- resolver-based extraction
- media evidence as the derived layer
- match reasons in retrieval output

That gives GBrain a clean path from page-centric media ingestion to artifact-centric media retrieval.

## Design rules

1. **Preserve provenance.** Every extracted result should point back to the original artifact and, when possible, the exact segment.
2. **Reuse existing primitives.** Feed pages, chunks, raw data, links, and search instead of building a parallel content universe.
3. **Stay backend-agnostic.** No required OCR vendor, embedding provider, or vector database.
4. **Expose match reasons.** Media retrieval without explanations will feel untrustworthy.
5. **Separate MVP from architecture.** A fork can ship quickly now while still using upstream-safe terminology.

## How to verify

1. Ingest an image or PDF and confirm the original binary is preserved.
2. Confirm extracted OCR/caption/transcript data is stored as provenance-bearing sidecar data.
3. Search for a phrase found only inside the media and confirm the item appears in results.
4. Confirm the result includes a useful match reason, such as page number or time range.
5. Confirm the page/search path still works even if a multimodal vector backend is not enabled.

## Related docs

- [Media Evidence Architecture](../designs/MEDIA_EVIDENCE_ARCHITECTURE.md)
- [Content and Media Ingestion](content-media.md)
- [GBrain Knowledge Runtime](../designs/KNOWLEDGE_RUNTIME.md)
