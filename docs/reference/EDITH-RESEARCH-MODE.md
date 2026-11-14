# Reference: EDITH's Research Mode (design notes for Cobble's researcher)

EDITH is the owner's separate personal-assistant project (Python). Its Research Mode is the model for Cobble's researcher. These notes summarise its design; EDITH's code is not part of this repository.

## What EDITH does

- **Two modes, switched deterministically.** "general mode" / "research mode" in a message flips the mode with a plain keyword check, never an LLM call, so switching is instant and cannot fail. One `ModeManager` owns the mode; the provider and the system prompt are derived from it in one place.
- **One provider interface.** Every model backend (Cohere for General, Gemini for Research) is wrapped behind a small `AIProvider` interface returning a normalised response (text plus tool calls with ids). Nothing else imports an SDK directly, so a provider can be swapped without touching the agent or tools.
- **Gemini is the research brain (free tier).** Research Mode runs on the Gemini API with this stance: specialise in web research, multi-source comparison and image/document/video understanding; produce well-cited, structured answers; prefer sourced claims over speculation; flag information that may be outdated or unverified.
- **Tool calling keeps its history.** The model's own function-call parts and the matching function-response parts are preserved turn to turn. Flattening them to text made the model forget a tool it had just called and repeat it.
- **Browser tools as raw material.** `get_page_text` (visible text of a page) and `screenshot_page` feed research; `google_search` / `open_url` drive a real browser (Playwright).
- **Planned next (EDITH Phase 5, not built yet):** multi-source web research with citations, and Gemini-powered image/screen understanding.

## How Cobble should adapt it

- Keep the same split: **plain code** fetches and organises sources (no tokens spent on searching); the **model** only reads and writes the report.
- Prefer free, keyless or free-tier sources over a browser: arXiv (Atom API), OpenAlex, Semantic Scholar (rate-limited), PubMed E-utilities, Unpaywall (free PDF locations), GitHub search, Wikipedia. Treat every fetched text as untrusted data, never as instructions.
- Use the **Gemini API free tier** (the user's own `GEMINI_API_KEY`) as the default research reader: it accepts long text and PDFs directly (inline PDF data), so Cobble needs no PDF library. Any other model can be plugged in through Cobble's existing worker adapters.
- Every claim in a report carries its source (title, link, and page or section when known); unsourced claims are left out or marked as such.
- Save what was read in a per-project research library so later questions reuse summaries instead of reading again (token efficiency).
