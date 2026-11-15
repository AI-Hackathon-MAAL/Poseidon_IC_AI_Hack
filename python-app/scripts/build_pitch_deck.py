"""Generate the Poseidon hackathon pitch deck (PowerPoint 16:9 widescreen).

Builds an 8-slide dark-theme presentation matching Poseidon's visual design
system, embedding real Stage 1/2/3 screenshots, Figma vector board renders,
system metrics verified from poseidon_snapshot.json, and Presenter View
speaker notes on every slide.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Iterable, Sequence

from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt


REPO_ROOT = Path(__file__).resolve().parents[2]
APP_ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_ROOT = Path(
    r"C:\Users\at3025\.gemini\antigravity\brain\6325c0ca-4cb9-41b8-94a9-71533e4df4bd"
)

ASSETS = {
    "stage1": ARTIFACT_ROOT / ".user_uploaded" / "media_1794716158655_e7bd4a31.jpg",
    "stage2": ARTIFACT_ROOT / ".user_uploaded" / "media_1794716209372_133c3e83.jpg",
    "stage3_explorer": (
        ARTIFACT_ROOT
        / "browser_evidence"
        / "a3303be0-c4c2-4b79-a57c-e334befc1d7d"
        / "final_step_34.png"
    ),
    "stage3_about": (
        ARTIFACT_ROOT
        / "browser_evidence"
        / "a3303be0-c4c2-4b79-a57c-e334befc1d7d"
        / "final_step_14.png"
    ),
    "fig_evo": ARTIFACT_ROOT / "scratch" / "fig_01_evolution.png",
    "fig_ds": ARTIFACT_ROOT / "scratch" / "fig_02_design_system.png",
    "fig_screens": ARTIFACT_ROOT / "scratch" / "fig_03_screens.png",
}

OUT_PATHS = [
    APP_ROOT / "Poseidon_Pitch_Deck.pptx",
    REPO_ROOT / "Poseidon_Pitch_Deck.pptx",
]

# Design System Colors
BG = "061017"
SURFACE = "0B1822"
SURFACE_ALT = "0F212E"
BORDER = "1A3040"
TEXT_PRIMARY = "F2F5F7"
TEXT_MUTED = "93A5AA"
ACCENT_CYAN = "78B7C9"
HIGH_RED = "F3837F"
MEDIUM_AMBER = "E4B468"
LOW_GREEN = "77C5A3"
QUEUED_GREY = "93A5AA"

FONT_FAMILY = "Segoe UI"


def rgb(hex_code: str) -> RGBColor:
    """Convert a 6-character hex string into an RGBColor."""
    return RGBColor.from_string(hex_code.lstrip("#"))


def verify_assets() -> None:
    """Ensure every required screenshot and Figma render exists before building."""
    missing = [f"{name}: {path}" for name, path in ASSETS.items() if not path.is_file()]
    if missing:
        raise FileNotFoundError(
            "Missing presentation image assets:\n" + "\n".join(missing)
        )


def set_slide_background(slide, hex_code: str = BG) -> None:
    """Apply a solid dark fill to a slide background."""
    bg = slide.background
    fill = bg.fill
    fill.solid()
    fill.fore_color.rgb = rgb(hex_code)


def add_rect(
    slide,
    left: float,
    top: float,
    width: float,
    height: float,
    fill_hex: str = SURFACE,
    border_hex: str | None = BORDER,
    rounded: bool = True,
    border_pt: float = 1.0,
):
    """Add a styled rectangle or rounded card."""
    shape_type = MSO_SHAPE.ROUNDED_RECTANGLE if rounded else MSO_SHAPE.RECTANGLE
    shape = slide.shapes.add_shape(
        shape_type, Inches(left), Inches(top), Inches(width), Inches(height)
    )
    if rounded and shape.adjustments:
        shape.adjustments[0] = 0.03
    shape.fill.solid()
    shape.fill.fore_color.rgb = rgb(fill_hex)
    if border_hex:
        shape.line.color.rgb = rgb(border_hex)
        shape.line.width = Pt(border_pt)
    else:
        shape.line.fill.background()
    return shape


def add_card(
    slide,
    left: float,
    top: float,
    width: float,
    height: float,
    fill_hex: str = SURFACE,
    border_hex: str = BORDER,
    accent_hex: str | None = None,
    accent_side: str = "left",
):
    """Add a card container with an optional thin color accent bar."""
    card = add_rect(slide, left, top, width, height, fill_hex=fill_hex, border_hex=border_hex)
    if accent_hex:
        if accent_side == "left":
            add_rect(
                slide,
                left + 0.02,
                top + 0.12,
                0.055,
                max(0.2, height - 0.24),
                fill_hex=accent_hex,
                border_hex=None,
                rounded=False,
            )
        else:
            add_rect(
                slide,
                left + 0.12,
                top + 0.02,
                max(0.2, width - 0.24),
                0.05,
                fill_hex=accent_hex,
                border_hex=None,
                rounded=False,
            )
    return card


def add_textbox(
    slide,
    left: float,
    top: float,
    width: float,
    height: float,
    paragraphs: Sequence[tuple[str, float, bool, str, float]],
    align=PP_ALIGN.LEFT,
    anchor=MSO_ANCHOR.TOP,
    margin: tuple[float, float, float, float] = (0.12, 0.12, 0.08, 0.08),
):
    """Insert a multi-paragraph text frame from (text, pt, bold, hex, space_after_pt) tuples."""
    tb = slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = Inches(margin[0])
    tf.margin_right = Inches(margin[1])
    tf.margin_top = Inches(margin[2])
    tf.margin_bottom = Inches(margin[3])

    for idx, (text, size_pt, bold, color_hex, space_after) in enumerate(paragraphs):
        p = tf.paragraphs[0] if idx == 0 else tf.add_paragraph()
        p.alignment = align
        p.space_after = Pt(space_after)
        run = p.add_run()
        run.text = text
        run.font.name = FONT_FAMILY
        run.font.size = Pt(size_pt)
        run.font.bold = bold
        run.font.color.rgb = rgb(color_hex)
    return tb


def add_badge(
    slide,
    left: float,
    top: float,
    width: float,
    height: float,
    text: str,
    bg_hex: str = SURFACE_ALT,
    fg_hex: str = ACCENT_CYAN,
    border_hex: str = BORDER,
    size_pt: float = 9.5,
):
    """Draw a compact pill badge with centered label."""
    shape = add_rect(slide, left, top, width, height, fill_hex=bg_hex, border_hex=border_hex)
    tf = shape.text_frame
    tf.word_wrap = False
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf.margin_left = Inches(0.06)
    tf.margin_right = Inches(0.06)
    tf.margin_top = Inches(0.02)
    tf.margin_bottom = Inches(0.02)
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    run.text = text
    run.font.name = FONT_FAMILY
    run.font.size = Pt(size_pt)
    run.font.bold = True
    run.font.color.rgb = rgb(fg_hex)
    return shape


def fit_picture(
    slide,
    img_path: Path,
    left: float,
    top: float,
    width: float,
    height: float,
    caption: str | None = None,
    border_hex: str = BORDER,
):
    """Frame and insert an image inside a target box while preserving aspect ratio."""
    add_rect(slide, left, top, width, height, fill_hex=SURFACE, border_hex=border_hex)
    caption_h = 0.34 if caption else 0.0
    pad = 0.08
    avail_w = max(0.5, width - 2 * pad)
    avail_h = max(0.5, height - 2 * pad - caption_h)

    with Image.open(img_path) as im:
        px_w, px_h = im.size
    ratio = px_w / px_h
    if avail_w / avail_h > ratio:
        disp_h = avail_h
        disp_w = disp_h * ratio
    else:
        disp_w = avail_w
        disp_h = disp_w / ratio

    pic_left = left + (width - disp_w) / 2.0
    pic_top = top + pad + (avail_h - disp_h) / 2.0
    slide.shapes.add_picture(
        str(img_path), Inches(pic_left), Inches(pic_top), Inches(disp_w), Inches(disp_h)
    )

    if caption:
        add_textbox(
            slide,
            left + 0.08,
            top + height - caption_h - 0.02,
            width - 0.16,
            caption_h,
            [(caption, 9.5, False, TEXT_MUTED, 0)],
            align=PP_ALIGN.CENTER,
            anchor=MSO_ANCHOR.MIDDLE,
            margin=(0.04, 0.04, 0.02, 0.02),
        )


def add_header(slide, kicker: str, title: str, slide_num: int, timing: str) -> None:
    """Render standard slide header and slide/timing pill."""
    add_rect(slide, 0.50, 0.24, 12.333, 0.025, fill_hex=BORDER, border_hex=None, rounded=False)
    add_textbox(
        slide,
        0.50,
        0.30,
        10.05,
        0.86,
        [
            (kicker.upper(), 10.0, True, ACCENT_CYAN, 2),
            (title, 21.5, True, TEXT_PRIMARY, 0),
        ],
        margin=(0.0, 0.0, 0.02, 0.02),
    )
    add_badge(
        slide,
        10.75,
        0.42,
        2.08,
        0.38,
        f"SLIDE {slide_num:02d} / 08  |  {timing}",
        bg_hex=SURFACE_ALT,
        fg_hex=TEXT_MUTED,
        border_hex=BORDER,
        size_pt=9.5,
    )


def add_footer(slide, page_label: str) -> None:
    """Render consistent footer compliance notice."""
    add_textbox(
        slide,
        0.50,
        7.12,
        12.333,
        0.30,
        [
            (
                f"POSEIDON · Autonomous Maritime Intelligence  |  {page_label}  |  All cases are apparent-fishing leads flagged for human review, not legal accusations.",
                8.5,
                False,
                TEXT_MUTED,
                0,
            )
        ],
        margin=(0.0, 0.0, 0.02, 0.0),
    )


def set_notes(slide, text: str) -> None:
    """Attach Presenter View speaker notes to a slide."""
    notes_slide = slide.notes_slide
    notes_slide.notes_text_frame.text = text.strip()


def build_slide_1(prs: Presentation) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    set_slide_background(slide)

    add_textbox(
        slide,
        0.55,
        0.45,
        6.10,
        2.95,
        [
            ("IMPERIAL AI HACKATHON  ·  AUTONOMOUS MARITIME INTELLIGENCE", 10.5, True, ACCENT_CYAN, 6),
            ("POSEIDON", 44.0, True, TEXT_PRIMARY, 4),
            ("Autonomous Vessel Investigation for Marine Protected Areas", 17.5, True, TEXT_PRIMARY, 10),
            (
                "Unifies Global Fishing Watch satellite AIS telemetry, Linkup live web intelligence, and Databricks Llama 4 Maverick into a spatial workspace for maritime analysts.",
                12.0,
                False,
                TEXT_MUTED,
                0,
            ),
        ],
        margin=(0.0, 0.0, 0.04, 0.04),
    )

    badges = [
        ("MAIN TRACK · AUTONOMOUS AGENTS", ACCENT_CYAN),
        ("DATABRICKS BOUNTY", MEDIUM_AMBER),
        ("BEST USE OF LINKUP", LOW_GREEN),
        ("FIGMA · BEST-DESIGNED AI PRODUCT", HIGH_RED),
    ]
    for i, (label, fg) in enumerate(badges):
        col, row = i % 2, i // 2
        add_badge(
            slide,
            0.55 + col * 3.05,
            3.50 + row * 0.46,
            2.95,
            0.36,
            label,
            bg_hex=SURFACE_ALT,
            fg_hex=fg,
            border_hex=BORDER,
            size_pt=9.0,
        )

    kpis = [
        ("10 MPAs Monitored", "Galapagos, Phoenix Islands, Hermandad & Pacific corridor", ACCENT_CYAN),
        ("197 Vessel Leads", "31 complete · 1 incomplete · 165 queued on-demand", HIGH_RED),
        ("8-Step Agent Loop", "GFW identity + ±72h check + 4 Linkup searches + LLM brief", LOW_GREEN),
        ("16+ Web Citations", "Audit-ready scoring breakdown & explicit Known Unknowns", MEDIUM_AMBER),
    ]
    for i, (head, sub, color) in enumerate(kpis):
        col, row = i % 2, i // 2
        x = 0.55 + col * 3.05
        y = 4.62 + row * 1.15
        add_card(slide, x, y, 2.95, 1.02, accent_hex=color)
        add_textbox(
            slide,
            x + 0.14,
            y + 0.08,
            2.72,
            0.88,
            [
                (head, 14.5, True, color, 3),
                (sub, 9.5, False, TEXT_MUTED, 0),
            ],
            margin=(0.06, 0.06, 0.04, 0.04),
        )

    fit_picture(
        slide,
        ASSETS["stage3_explorer"],
        6.88,
        0.48,
        5.95,
        6.45,
        caption="Live UI: Full-bleed 3D Vessel Explorer with on-demand Python agent execution",
    )
    add_footer(slide, "Title & Overview")
    set_notes(
        slide,
        """TIMING: 0:00 - 0:25
OPENING HOOK:
- "Protecting vast Marine Protected Areas like the Galapagos or Phoenix Islands means triaging hundreds of satellite pings, unexplained AIS blackouts, and opaque shell owners."
- "Poseidon is an autonomous maritime investigation workspace built in one self-contained Python app: it brings Global Fishing Watch telemetry, live Linkup web research, and Databricks Llama 4 Maverick together behind a clean 3D spatial UI."
- Quick note: If using this slide just to orient judges, switch directly to the Problem slide (or your live browser window) after 20 seconds.""",
    )


def build_slide_2(prs: Presentation) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    set_slide_background(slide)
    add_header(slide, "01 · Problem & Design Principle", "Why Raw Satellite Alerts Fail Maritime Analysts", 2, "0:25 - 0:55")

    add_badge(slide, 0.50, 1.24, 5.95, 0.36, "WHY RAW SATELLITE ALERTS FAIL", SURFACE_ALT, HIGH_RED, BORDER, 10.5)
    add_badge(slide, 6.88, 1.24, 5.95, 0.36, "HOW POSEIDON SOLVES IT", SURFACE_ALT, LOW_GREEN, BORDER, 10.5)

    problems = [
        (
            "1. Massive Alert Fatigue & Transit Noise",
            "Our snapshot tracks 197 vessels across 10 MPAs — 114 vessels sit inside Phoenix Islands Protected Area alone, mostly single-ping transits that drown out true anomalies.",
            HIGH_RED,
        ),
        (
            "2. Unexplained AIS Dark Gaps",
            "Fishing vessels go dark for days or weeks (e.g. ANDREA D: 1,152.52 hours over 1,671 km), leaving coordinates with zero context on what happened right before or after.",
            HIGH_RED,
        ),
        (
            "3. Opaque Owners & Hallucination Risk",
            "AIS feeds rarely surface beneficial owners, past detentions, or reserve boundaries. Asking a generic LLM to summarize pings invites unverified accusations.",
            HIGH_RED,
        ),
    ]
    solutions = [
        (
            "1. Smart Triage & Grey Queued States",
            "31 high-signal leads are pre-investigated while 165 low-score transits render in muted grey (#93A5AA) — keeping map clutter near zero until an analyst clicks 'Run Python agent'.",
            LOW_GREEN,
        ),
        (
            "2. ±72h & 12-Month Behavioral Verification",
            "The agent queries GFW v3 around every gap (confirming 0.0h post-gap apparent fishing on ANDREA D) and pulls 12-month baselines (gaps, fishing, loitering, port visits).",
            ACCENT_CYAN,
        ),
        (
            "3. Linkup Web Grounding + Deterministic Audit",
            "Every brief pairs real Linkup URLs ([1]-[16]) with a transparent rule-based point score and explicit Known Unknowns — surfacing leads for review, never accusations.",
            LOW_GREEN,
        ),
    ]

    for idx, (title, body, color) in enumerate(problems):
        y = 1.74 + idx * 1.75
        add_card(slide, 0.50, y, 5.95, 1.58, accent_hex=color)
        add_textbox(
            slide,
            0.66,
            y + 0.10,
            5.65,
            1.38,
            [
                (title, 14.0, True, TEXT_PRIMARY, 6),
                (body, 11.2, False, TEXT_MUTED, 0),
            ],
        )

    for idx, (title, body, color) in enumerate(solutions):
        y = 1.74 + idx * 1.75
        add_card(slide, 6.88, y, 5.95, 1.58, accent_hex=color)
        add_textbox(
            slide,
            7.04,
            y + 0.10,
            5.65,
            1.38,
            [
                (title, 14.0, True, color, 6),
                (body, 11.2, False, TEXT_PRIMARY, 0),
            ],
        )

    add_footer(slide, "Problem -> Solution")
    set_notes(
        slide,
        """TIMING: 0:25 - 0:55
KEY POINTS TO SAY:
- "First, notice the scale problem: 197 vessels, and over half (114) are packed inside Phoenix Islands Protected Area. Most are just brief transits."
- "Second, when a boat turns off AIS for 1,152 hours like ANDREA D, raw telemetry does not tell you whether its equipment broke or it resumed fishing the instant it reappeared."
- "So we built Poseidon around responsible AI: deterministic scoring + real Linkup citations + explicit Known Unknowns. Every case is a lead for human review, never proof of illegal fishing.""",
    )


def build_slide_3(prs: Presentation) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    set_slide_background(slide)
    add_header(slide, "02 · Databricks + Linkup + Python Architecture", "Unified Self-Contained Stack: Batch Pipeline to Live App", 3, "0:55 - 1:30")

    tiers = [
        (
            "1. DATA & BATCH LAYER · DATABRICKS LAKEFLOW",
            MEDIUM_AMBER,
            [
                "• notebooks/poseidon.py + deploy/poseidon-hourly.job.json run hourly batch GFW sweeps.",
                "• Writes cleaned MPA & vessel leads to Unity Catalog Volume (POSEIDON_VOLUME).",
                "• POST /api/sync-databricks pulls fresh poseidon_snapshot.json via Databricks Files API.",
            ],
        ),
        (
            "2. INTELLIGENCE LAYER · AUTONOMOUS AGENT",
            ACCENT_CYAN,
            [
                "• databricks-llama-4-maverick serving endpoint powers tool orchestration & synthesis.",
                "• Global Fishing Watch v3 supplies events, vessel identity & 12-month activity history.",
                "• Linkup live web search runs 4 targeted queries per vessel (optional Tavily fallback).",
            ],
        ),
        (
            "3. UNIFIED APP · poseidon-app/ (PYTHON 3.14)",
            LOW_GREEN,
            [
                "• Single ThreadingHTTPServer (app.py + app.yaml for Databricks Apps deployment).",
                "• REST API: GET /api/status, GET /api/snapshot, POST /api/investigate.",
                "• Hybrid fallback (SnapshotGFWAdapter & SnapshotSearchAdapter) guarantees reliable demos.",
            ],
        ),
    ]

    for idx, (title, color, bullets) in enumerate(tiers):
        y = 1.28 + idx * 1.90
        add_card(slide, 0.50, y, 6.75, 1.72, accent_hex=color)
        paras = [(title, 12.5, True, color, 5)] + [(b, 10.2, False, TEXT_PRIMARY, 4) for b in bullets]
        add_textbox(slide, 0.68, y + 0.08, 6.42, 1.56, paras)

    fit_picture(
        slide,
        ASSETS["stage3_about"],
        7.48,
        1.28,
        5.35,
        5.52,
        caption="Built-in Engine Status view showing Python runtime, GFW, Linkup & Databricks modes",
    )
    add_footer(slide, "System Architecture")
    set_notes(
        slide,
        """TIMING: 0:55 - 1:30
DATABRICKS BOUNTY TALKING POINTS:
- "Early in the hackathon our code was scattered across notebooks and separate scripts. We consolidated the entire system into poseidon-app/."
- "On Databricks, an hourly Lakeflow job runs notebooks/poseidon.py and stores snapshots in a Unity Catalog volume, while databricks-llama-4-maverick handles agent reasoning and brief writing."
- "Our Python server app.py runs locally or directly on Databricks Apps (app.yaml), and uses hybrid snapshot adapters so if hackathon Wi-Fi hiccups, live 'Run Python agent' calls still complete cleanly.""",
    )


def build_slide_4(prs: Presentation) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    set_slide_background(slide)
    add_header(slide, "03 · Autonomous Agent & Linkup Deep Dive", "Inside the 8-Step Investigation: Case Study ANDREA D", 4, "1:30 - 2:10")

    add_card(slide, 0.50, 1.24, 12.333, 1.00, fill_hex=SURFACE_ALT, accent_hex=HIGH_RED)
    add_textbox(
        slide,
        0.70,
        1.30,
        8.65,
        0.90,
        [
            ("ANDREA D  (Flag: ECU  ·  MMSI: 735060342  ·  IMO: 8915134  ·  Owner: ELVAYKA KYOEI)", 12.0, True, TEXT_PRIMARY, 3),
            ("Iles Galapagos World Heritage Site  ·  1,152.52 h AIS gap across 1,671.13 km  ·  Apparent fishing resumed 0.0 h later", 10.3, False, TEXT_MUTED, 0),
        ],
    )
    add_badge(slide, 9.45, 1.38, 1.70, 0.36, "RISK 90/100 · HIGH", SURFACE, HIGH_RED, HIGH_RED, 9.5)
    add_badge(slide, 11.25, 1.38, 1.42, 0.36, "16 WEB SOURCES", SURFACE, LOW_GREEN, BORDER, 9.5)
    add_badge(slide, 9.45, 1.79, 3.22, 0.30, "Autonomous 8/8 Steps Complete · Flagged for Review", SURFACE, TEXT_MUTED, BORDER, 8.5)

    steps = [
        ("STEP 1 · GFW IDENTITY", "Resolve Vessel & Owners", "Matched IMO 8915134, ECU/JPN flag records & beneficial owners ELVAYKA KYOEI / KYOKUYO SUISAN.", ACCENT_CYAN),
        ("STEP 2 · GFW TELEMETRY", "Check Activity ±72h", "Verified 1,152.52 h AIS gap across 1,671 km followed immediately (0.0 h) by apparent fishing.", ACCENT_CYAN),
        ("STEP 3 · GFW BASELINE", "12-Month Vessel History", "Extracted 4 tracking gaps, 28 fishing events, 32 loitering events & 11 port visits in prior year.", ACCENT_CYAN),
        ("STEP 4 · LINKUP WEB", "MPA Protection Rules", "Live web query for Galapagos Marine Reserve / WHS zoning and industrial fishing prohibitions.", LOW_GREEN),
        ("STEP 5 · LINKUP WEB", "Owner & Fleet Records", "Live web research on ELVAYKA KYOEI corporate structure and fleet compliance history.", LOW_GREEN),
        ("STEP 6 · LINKUP WEB", "IUU & Vessel Registries", "Cross-referenced RFMO authorized/IUU vessel databases, detentions & flag changes.", LOW_GREEN),
        ("STEP 7 · LINKUP WEB", "Regional Enforcement News", "Searched recent Eastern Tropical Pacific maritime patrol & enforcement press reports.", LOW_GREEN),
        ("STEP 8 · DATABRICKS LLM", "Score + Grounded Brief", "Computed deterministic 90/100 breakdown, cited 16 Linkup sources & listed Known Unknowns.", MEDIUM_AMBER),
    ]

    for idx, (tag, name, desc, color) in enumerate(steps):
        col, row = idx % 4, idx // 4
        x = 0.50 + col * 3.13
        y = 2.38 + row * 2.32
        add_card(slide, x, y, 2.93, 2.12, accent_hex=color, accent_side="top")
        add_badge(slide, x + 0.14, y + 0.18, 2.65, 0.28, tag, SURFACE_ALT, color, BORDER, 8.5)
        add_textbox(
            slide,
            x + 0.10,
            y + 0.52,
            2.73,
            1.48,
            [
                (name, 13.0, True, TEXT_PRIMARY, 5),
                (desc, 10.3, False, TEXT_MUTED, 0),
            ],
        )

    add_footer(slide, "Autonomous Agent Loop")
    set_notes(
        slide,
        """TIMING: 1:30 - 2:10
AUTONOMOUS AGENTS + BEST USE OF LINKUP:
- "Why is this a true autonomous agent and not a single LLM prompt? Notice the 8-step evidence pipeline on screen."
- "Steps 1-3 interrogate Global Fishing Watch: who owns the hull, did fishing happen right after the 1,152-hour blackout, and what is its 12-month track record?"
- "Steps 4-7 are driven by Linkup live web search across four distinct angles: local reserve rules, corporate owners, RFMO/IUU databases, and regional Galapagos enforcement news — producing 16 unique web citations for ANDREA D."
- "Step 8 combines deterministic risk math with Databricks Llama 4 Maverick to produce a human-auditable brief.""",
    )


def build_slide_5(prs: Presentation) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    set_slide_background(slide)
    add_header(slide, "04 · Live 60-Second Demo Run Sheet", "Exactly What to Click in the Live Browser Demo", 5, "2:10 - 3:10")

    beats = [
        (
            "BEAT 1  (0:00 - 0:15)  ·  Global Globe -> Galapagos",
            "Start on full-bleed globe (10 MPAs, 197 cases). Filter to 'Iles Galapagos - World Heritage Site (natural or mixed)' (12 vessels).",
            ACCENT_CYAN,
        ),
        (
            "BEAT 2  (0:15 - 0:30)  ·  High-Risk Lead (ANDREA D)",
            "Click red marker ANDREA D (90/100 HIGH). Note how red stays red on selection, then click 'View agent report' to open the drawer.",
            HIGH_RED,
        ),
        (
            "BEAT 3  (0:30 - 0:45)  ·  Audit the 8-Step Agent",
            "Click 'Replay agent trace' inside the drawer to animate Steps 1-8, scroll Linkup citations [1]-[16], and point out Known Unknowns.",
            MEDIUM_AMBER,
        ),
        (
            "BEAT 4  (0:45 - 1:00)  ·  Live Python Agent Execution",
            "Click grey queued vessel PESQUERO PIQUERO -> hit 'Run Python agent' (POST /api/investigate) -> watch Queued become a Complete report live.",
            LOW_GREEN,
        ),
    ]

    for idx, (title, body, color) in enumerate(beats):
        y = 1.28 + idx * 1.42
        add_card(slide, 0.50, y, 6.20, 1.26, accent_hex=color)
        add_textbox(
            slide,
            0.68,
            y + 0.08,
            5.88,
            1.10,
            [
                (title, 12.8, True, color, 4),
                (body, 10.6, False, TEXT_PRIMARY, 0),
            ],
        )

    fit_picture(
        slide,
        ASSETS["stage3_explorer"],
        6.92,
        1.28,
        5.91,
        5.52,
        caption="Beat 4 screen: PESQUERO PIQUERO selected in Galapagos with live 'Run Python agent' action",
    )
    add_footer(slide, "Live Demo Script")
    set_notes(
        slide,
        """TIMING: 2:10 - 3:10
DEMO TIP:
- Open http://127.0.0.1:8000 (started with `python app.py`) BEFORE stepping up to present!
- Do NOT scroll aimlessly around Phoenix Islands' 114 boats during the 60s demo — stick to this 4-beat path:
  1) Filter to Galapagos
  2) Click red ANDREA D -> open Agent report drawer
  3) Click Replay agent trace + highlight [1]-[16] Linkup links
  4) Click grey PESQUERO PIQUERO -> click Run Python agent live!""",
    )


def build_slide_6(prs: Presentation) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    set_slide_background(slide)
    add_header(slide, "05 · Figma UI Iteration Evidence", "Design Evolution: From Cluttered Dashboard to Spatial Canvas", 6, "3:10 - 3:45")

    stages = [
        (
            ASSETS["stage1"],
            "STAGE 1 · EARLY 3-COLUMN DASHBOARD",
            "Cluttered telemetry wall: flat 2D map squeezed between an alert queue, permanent text wall & bottom MPA cards.",
            HIGH_RED,
            "Stage 1: Dense 3-column prototype",
        ),
        (
            ASSETS["stage2"],
            "STAGE 2 · BOXED 3D GLOBE",
            "Added interactive 3D globe inside center box, but sidebars still consumed >65% of viewport height/width.",
            MEDIUM_AMBER,
            "Stage 2: Boxed 3D globe inside grid",
        ),
        (
            ASSETS["stage3_explorer"],
            "STAGE 3 · FULL-BLEED SPATIAL UI",
            "Globe owns 100% viewport. Progressive disclosure (list -> focus card -> drawer) & locked risk colors on click.",
            LOW_GREEN,
            "Stage 3: Shipped full-bleed spatial UI",
        ),
    ]

    for idx, (img_path, title, desc, color, cap) in enumerate(stages):
        x = 0.50 + idx * 4.21
        w = 3.91
        fit_picture(slide, img_path, x, 1.28, w, 3.25, caption=cap, border_hex=BORDER)
        add_card(slide, x, 4.68, w, 2.15, accent_hex=color, accent_side="top")
        add_textbox(
            slide,
            x + 0.12,
            4.82,
            w - 0.24,
            1.88,
            [
                (title, 11.5, True, color, 6),
                (desc, 10.5, False, TEXT_PRIMARY, 0),
            ],
        )

    add_footer(slide, "Best-Designed AI Product · UI Evolution")
    set_notes(
        slide,
        """TIMING: 3:10 - 3:45
FIGMA PRIZE (£960 + MERCH) PITCH:
- "To qualify for Best-Designed AI Product, we documented our real design journey instead of hiding messy iterations."
- "Stage 1 was a classic hackathon dashboard trap — 3 dense columns fighting for attention. Stage 2 swapped in a 3D globe, still boxed inside the clutter."
- "In Stage 3, we made the 3D globe full-bleed, hid the 8-step AI report inside an on-demand drawer, and fixed selection state semantics so High/Medium/Low/Queued boats retain their true map color when clicked.""",
    )


def build_slide_7(prs: Presentation) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    set_slide_background(slide)
    add_header(slide, "06 · Figma & FigJam Proof Pack", "Design System, FigJam Flows & Shipped Interactive Code Layer", 7, "3:45 - 4:10")

    boards = [
        (ASSETS["fig_evo"], "Figma Node 1:2 · UI Evolution Timeline"),
        (ASSETS["fig_ds"], "Figma Node 1:224 · Tokens & Components"),
        (ASSETS["fig_screens"], "Figma Node 1:395 · Annotated Screens"),
    ]
    for idx, (img_path, cap) in enumerate(boards):
        x = 0.50 + idx * 4.21
        fit_picture(slide, img_path, x, 1.26, 3.91, 2.75, caption=cap)

    add_card(slide, 0.50, 4.18, 6.02, 2.68, accent_hex=ACCENT_CYAN)
    add_textbox(
        slide,
        0.68,
        4.28,
        5.68,
        2.50,
        [
            ("FIGMA DESIGN FILE  ·  CyICgl58TgTWa3TtqpyMOE", 12.0, True, ACCENT_CYAN, 6),
            ("• 3 Editable Vector Boards (nodes 1:2, 1:224, 1:395) parsed natively in Figma.", 10.2, False, TEXT_PRIMARY, 4),
            ("• 4 Before/After Reference Screenshots (nodes 1:529-1:532) pinned side-by-side.", 10.2, False, TEXT_PRIMARY, 4),
            ("• Shipped Web Frontend imported as an interactive Code Layer (node 2:3 via send_code_to_figma).", 10.2, False, TEXT_PRIMARY, 4),
            ("• Shared Color Discipline: High #F3837F · Med #E4B468 · Low #77C5A3 · Queued #93A5AA.", 10.2, False, TEXT_MUTED, 0),
        ],
    )

    add_card(slide, 6.81, 4.18, 6.02, 2.68, accent_hex=MEDIUM_AMBER)
    add_textbox(
        slide,
        6.99,
        4.28,
        5.68,
        2.50,
        [
            ("FIGJAM ARCHITECTURE BOARD  ·  JlvYfFIsZsemhRyRZA5qVE", 12.0, True, MEDIUM_AMBER, 6),
            ("• Diagram 1: End-to-End System Architecture (GFW v3 + Linkup + Databricks + Python app.py).", 10.2, False, TEXT_PRIMARY, 4),
            ("• Diagram 2: Autonomous 8-Step Agent Decision Loop & 3-Stage UI Evolution Flowchart.", 10.2, False, TEXT_PRIMARY, 4),
            ("• Bidirectional link: Design tokens & drawer layout match poseidon-app/web/ stylesheets.", 10.2, False, TEXT_PRIMARY, 4),
            ("• Ready to open live for Figma prize reviewers during Q&A.", 10.2, False, TEXT_MUTED, 0),
        ],
    )

    add_footer(slide, "Figma Deliverables & Code Layer")
    set_notes(
        slide,
        """TIMING: 3:45 - 4:10
FIGMA DELIVERABLES SUMMARY:
- "Here is our concrete Figma proof: we have both a FigJam board (JlvYfFIsZsemhRyRZA5qVE) mapping our system architecture and agent loop, and a Figma Design file (CyICgl58TgTWa3TtqpyMOE) containing editable vector timelines, design tokens, our real before/after screenshots, AND the shipped web frontend imported back as an interactive Code Layer (node 2:3)."
- Honest note: If someone asks whether Figma's hosted Code Layer preview ran tests, state clearly that our runtime verification was done directly on the live Python server (`python app.py`) and browser verifier, and the source bundle is imported as `node 2:3` inside Figma.""",
    )


def build_slide_8(prs: Presentation) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    set_slide_background(slide)
    add_header(slide, "07 · Prize Alignment & Judge Q&A", "Track Qualification Matrix & Ready Answers", 8, "4:10 - Q&A")

    add_badge(slide, 0.50, 1.24, 5.45, 0.34, "PRIZES & BOUNTIES QUALIFICATION", SURFACE_ALT, ACCENT_CYAN, BORDER, 10.0)
    add_badge(slide, 6.20, 1.24, 6.63, 0.34, "JUDGE Q&A CHEAT SHEET", SURFACE_ALT, HIGH_RED, BORDER, 10.0)

    tracks = [
        ("MAIN TRACK · AUTONOMOUS AGENTS", "8-step investigation loop, step replay, deterministic score & live /api/investigate.", ACCENT_CYAN),
        ("DATABRICKS BOUNTY", "Hourly Lakeflow job + UC Volume sync (poseidon.py), app.yaml & Llama 4 Maverick briefs.", MEDIUM_AMBER),
        ("BEST USE OF LINKUP", "4 live web searches per vessel (rules, owners, IUU, news) yielding up to 16 citations.", LOW_GREEN),
        ("FIGMA · BEST-DESIGNED AI PRODUCT", "FigJam architecture + Figma vector boards + before/after shots + Code Layer (node 2:3).", HIGH_RED),
    ]
    for idx, (t_head, t_body, color) in enumerate(tracks):
        y = 1.68 + idx * 1.30
        add_card(slide, 0.50, y, 5.45, 1.16, accent_hex=color)
        add_textbox(
            slide,
            0.66,
            y + 0.08,
            5.15,
            1.02,
            [
                (t_head, 11.2, True, color, 3),
                (t_body, 10.0, False, TEXT_PRIMARY, 0),
            ],
        )

    qas = [
        ("Q: Why do fishing boats show 1,000+ hour date gaps?", "Long-haul vessels disable AIS or cross satellite coverage gaps (ANDREA D: 1,152.52 h). Our agent specifically checks if apparent fishing resumes right upon re-entry (0.0 h)."),
        ("Q: Why is Phoenix Islands packed with 114 grey boats?", "It is a huge Pacific corridor (114 of 197 leads), mostly brief low-score transits. Rendering queued vessels in muted grey prevents alert clutter while keeping analysis 1 click away."),
        ("Q: Are you actually using Databricks right now?", "Yes: hourly Lakeflow job & UC Volume sync (notebooks/poseidon.py) + databricks-llama-4-maverick endpoint, paired with local snapshot adapters so demos never stall."),
        ("Q: Does Poseidon accuse boats of illegal fishing?", "Never. Every report states findings are apparent-fishing leads flagged for review and highlights Known Unknowns such as valid licenses or AIS dropouts."),
    ]
    for idx, (q, a) in enumerate(qas):
        y = 1.68 + idx * 1.30
        add_card(slide, 6.20, y, 6.63, 1.16, accent_hex=BORDER)
        add_textbox(
            slide,
            6.34,
            y + 0.06,
            6.35,
            1.04,
            [
                (q, 10.8, True, ACCENT_CYAN, 2),
                (a, 9.7, False, TEXT_PRIMARY, 0),
            ],
        )

    add_footer(slide, "Q&A & Track Summary")
    set_notes(
        slide,
        """TIMING: 4:10 - END / Q&A
CLOSE WITH CONFIDENCE:
- "In summary: Poseidon unifies Global Fishing Watch telemetry, Linkup live web evidence, Databricks compute & Llama 4 Maverick synthesis, and a full-bleed Figma-documented UI inside a single self-contained Python app."
- Keep this slide open during Q&A so the 4 Track rows and 4 hard questions sit right in front of you!""",
    )


def build_deck() -> list[Path]:
    """Generate the pitch deck and mirror it to poseidon-app/ and repo root."""
    verify_assets()
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)

    build_slide_1(prs)
    build_slide_2(prs)
    build_slide_3(prs)
    build_slide_4(prs)
    build_slide_5(prs)
    build_slide_6(prs)
    build_slide_7(prs)
    build_slide_8(prs)

    primary = OUT_PATHS[0]
    prs.save(str(primary))
    for mirror in OUT_PATHS[1:]:
        shutil.copy2(primary, mirror)
    return OUT_PATHS


if __name__ == "__main__":
    written = build_deck()
    for path in written:
        print(f"Wrote {path} ({path.stat().st_size} bytes)")
