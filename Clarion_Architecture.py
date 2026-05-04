"""
Clarion Architecture Document — PDF Generator
Creates a professional architecture document with diagrams and visuals.
"""

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm, mm
from reportlab.lib.colors import HexColor, white, black
from reportlab.pdfgen import canvas
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import Paragraph
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

W, H = A4  # 595.27, 841.89

# Brand colors
DARK_BLUE = HexColor('#1a237e')
MID_BLUE = HexColor('#283593')
LIGHT_BLUE = HexColor('#5c6bc0')
PURPLE = HexColor('#7b1fa2')
LIGHT_PURPLE = HexColor('#9c27b0')
ACCENT = HexColor('#4a148c')
BG_GRAY = HexColor('#f5f5f5')
CARD_GRAY = HexColor('#eceff1')
BORDER_GRAY = HexColor('#b0bec5')
TEXT_DARK = HexColor('#212121')
TEXT_MID = HexColor('#424242')
TEXT_LIGHT = HexColor('#757575')
GREEN = HexColor('#2e7d32')
ORANGE = HexColor('#e65100')
RED = HexColor('#c62828')
TEAL = HexColor('#00695c')
AMBER = HexColor('#ff8f00')

def rounded_rect(c, x, y, w, h, r=6, fill=None, stroke=None, stroke_width=1):
    """Draw a rounded rectangle."""
    p = c.beginPath()
    p.roundRect(x, y, w, h, r)
    p.close()
    if fill:
        c.setFillColor(fill)
    if stroke:
        c.setStrokeColor(stroke)
        c.setLineWidth(stroke_width)
    if fill and stroke:
        c.drawPath(p, fill=1, stroke=1)
    elif fill:
        c.drawPath(p, fill=1, stroke=0)
    elif stroke:
        c.drawPath(p, fill=0, stroke=1)

def arrow(c, x1, y1, x2, y2, color=TEXT_LIGHT, width=1.5, head_size=6):
    """Draw an arrow from (x1,y1) to (x2,y2)."""
    import math
    c.setStrokeColor(color)
    c.setLineWidth(width)
    c.line(x1, y1, x2, y2)
    # Arrowhead
    angle = math.atan2(y2 - y1, x2 - x1)
    c.setFillColor(color)
    p = c.beginPath()
    p.moveTo(x2, y2)
    p.lineTo(x2 - head_size * math.cos(angle - 0.4), y2 - head_size * math.sin(angle - 0.4))
    p.lineTo(x2 - head_size * math.cos(angle + 0.4), y2 - head_size * math.sin(angle + 0.4))
    p.close()
    c.drawPath(p, fill=1, stroke=0)

def draw_box(c, x, y, w, h, label, sublabel=None, color=LIGHT_BLUE, text_color=white, font_size=9, icon=None):
    """Draw a labeled box with optional sublabel."""
    rounded_rect(c, x, y, w, h, r=5, fill=color)
    c.setFillColor(text_color)
    c.setFont("Helvetica-Bold", font_size)
    ty = y + h/2 + (3 if sublabel else 0)
    c.drawCentredString(x + w/2, ty, label)
    if sublabel:
        c.setFont("Helvetica", font_size - 2)
        c.setFillColor(HexColor('#e0e0e0') if text_color == white else TEXT_LIGHT)
        c.drawCentredString(x + w/2, ty - 12, sublabel)

def section_header(c, y, title, number):
    """Draw a section header bar."""
    c.setFillColor(DARK_BLUE)
    c.rect(0, y, W, 32, fill=1, stroke=0)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 14)
    c.drawString(30, y + 9, f"{number}. {title}")
    return y - 15

def page_footer(c, page_num):
    """Draw page footer."""
    c.setFillColor(BORDER_GRAY)
    c.line(30, 35, W - 30, 35)
    c.setFillColor(TEXT_LIGHT)
    c.setFont("Helvetica", 8)
    c.drawString(30, 22, "Clarion Technical Architecture")
    c.drawRightString(W - 30, 22, f"Page {page_num}")

def create_pdf():
    c = canvas.Canvas("C:/Users/vandarn/Documents/databridge/Clarion_Architecture.pdf", pagesize=A4)
    page_num = 0

    # =========================================================================
    # PAGE 1 — TITLE PAGE
    # =========================================================================
    page_num += 1
    # Background gradient effect
    for i in range(50):
        shade = HexColor(f'#{hex(26 + i)[2:].zfill(2)}{hex(35 + i)[2:].zfill(2)}{hex(126 + i*2)[2:].zfill(2)}')
        c.setFillColor(shade)
        c.rect(0, H - (i * H/50), W, H/50 + 1, fill=1, stroke=0)

    # Logo area
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 42)
    c.drawCentredString(W/2, H - 280, "Clarion")

    c.setFont("Helvetica", 18)
    c.setFillColor(HexColor('#b39ddb'))
    c.drawCentredString(W/2, H - 320, "Technical Architecture Overview")

    # Decorative line
    c.setStrokeColor(HexColor('#7c4dff'))
    c.setLineWidth(2)
    c.line(W/2 - 100, H - 340, W/2 + 100, H - 340)

    c.setFillColor(HexColor('#e0e0e0'))
    c.setFont("Helvetica", 13)
    c.drawCentredString(W/2, H - 370, "AI-Powered Semantic Data Platform")

    c.setFont("Helvetica", 11)
    c.setFillColor(HexColor('#9e9e9e'))
    c.drawCentredString(W/2, H - 420, "Version 1.0  |  April 2026")

    # Bottom info box
    rounded_rect(c, W/2 - 180, 80, 360, 100, r=8, fill=HexColor('#1a1a40'))
    c.setFillColor(HexColor('#b0bec5'))
    c.setFont("Helvetica", 9)
    c.drawCentredString(W/2, 155, "Confidential  |  EpicData BV")
    c.drawCentredString(W/2, 140, "Architecture & Infrastructure Documentation")
    c.drawCentredString(W/2, 115, "Azure Container Apps  |  PostgreSQL  |  Neo4j  |  Claude AI")
    c.drawCentredString(W/2, 100, "Next.js  |  Express  |  TypeScript  |  Terraform")

    c.showPage()

    # =========================================================================
    # PAGE 2 — SYSTEM OVERVIEW
    # =========================================================================
    page_num += 1
    y = H - 20
    y = section_header(c, y, "System Overview", 1)

    # Description
    c.setFillColor(TEXT_MID)
    c.setFont("Helvetica", 9)
    c.drawString(30, y, "Clarion enables business users to query their data using natural language, powered by a semantic layer and Claude AI.")
    y -= 25

    # Three-layer architecture diagram
    diag_top = y
    diag_left = 30
    diag_width = W - 60

    # Users column on the left
    draw_box(c, 30, diag_top - 55, 90, 35, "Admin", "Setup & manage", PURPLE)
    draw_box(c, 30, diag_top - 100, 90, 35, "Client User", "Query & reports", LIGHT_PURPLE)

    # Arrow from users to frontend
    arrow(c, 120, diag_top - 37, 150, diag_top - 37, PURPLE, 2)
    arrow(c, 120, diag_top - 82, 150, diag_top - 82, LIGHT_PURPLE, 2)

    # Layer 1: Frontend
    rounded_rect(c, 150, diag_top - 115, 410, 85, r=8, fill=HexColor('#e8eaf6'), stroke=LIGHT_BLUE, stroke_width=2)
    c.setFillColor(DARK_BLUE)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(160, diag_top - 20, "FRONTEND")

    draw_box(c, 160, diag_top - 55, 80, 28, "Login", None, LIGHT_BLUE, white, 8)
    draw_box(c, 250, diag_top - 55, 80, 28, "Setup", None, LIGHT_BLUE, white, 8)
    draw_box(c, 340, diag_top - 55, 80, 28, "Chat/Query", None, LIGHT_BLUE, white, 8)
    draw_box(c, 430, diag_top - 55, 80, 28, "Dashboards", None, LIGHT_BLUE, white, 8)
    draw_box(c, 160, diag_top - 95, 80, 28, "Reports", None, LIGHT_BLUE, white, 8)
    draw_box(c, 250, diag_top - 95, 80, 28, "Semantic", None, LIGHT_BLUE, white, 8)
    draw_box(c, 340, diag_top - 95, 80, 28, "Gaps/Log", None, LIGHT_BLUE, white, 8)
    draw_box(c, 430, diag_top - 95, 80, 28, "Users", None, LIGHT_BLUE, white, 8)

    c.setFillColor(TEXT_LIGHT)
    c.setFont("Helvetica", 7)
    c.drawRightString(555, diag_top - 110, "Next.js 14 | Tailwind | Recharts")

    # Arrow down
    arrow(c, W/2, diag_top - 115, W/2, diag_top - 135, MID_BLUE, 2)
    c.setFillColor(MID_BLUE)
    c.setFont("Helvetica", 7)
    c.drawCentredString(W/2 + 25, diag_top - 128, "REST API")

    # Layer 2: Backend
    rounded_rect(c, 150, diag_top - 265, 410, 120, r=8, fill=HexColor('#fce4ec'), stroke=HexColor('#e91e63'), stroke_width=2)
    c.setFillColor(HexColor('#880e4f'))
    c.setFont("Helvetica-Bold", 10)
    c.drawString(160, diag_top - 153, "BACKEND")

    draw_box(c, 160, diag_top - 185, 90, 25, "Auth + JWT", None, HexColor('#e91e63'), white, 8)
    draw_box(c, 260, diag_top - 185, 90, 25, "Routes", None, HexColor('#e91e63'), white, 8)
    draw_box(c, 360, diag_top - 185, 90, 25, "AIService.ts", None, HexColor('#9c27b0'), white, 8)
    draw_box(c, 460, diag_top - 185, 90, 25, "Connectors", None, HexColor('#e91e63'), white, 8)

    draw_box(c, 160, diag_top - 220, 90, 25, "SchemaProfiler", None, HexColor('#ad1457'), white, 7)
    draw_box(c, 260, diag_top - 220, 90, 25, "Query Engine", None, HexColor('#ad1457'), white, 8)
    draw_box(c, 360, diag_top - 220, 90, 25, "KPI Engine", None, HexColor('#ad1457'), white, 8)
    draw_box(c, 460, diag_top - 220, 90, 25, "Validator", None, HexColor('#ad1457'), white, 8)

    draw_box(c, 160, diag_top - 255, 190, 25, "Knex.js Query Builder", None, HexColor('#880e4f'), white, 8)
    draw_box(c, 360, diag_top - 255, 190, 25, "ConnectorPool + Factory", None, HexColor('#880e4f'), white, 8)

    c.setFillColor(TEXT_LIGHT)
    c.setFont("Helvetica", 7)
    c.drawRightString(555, diag_top - 260, "Express | TypeScript | Node.js 20")

    # Arrows down to databases
    arrow(c, 250, diag_top - 265, 250, diag_top - 290, GREEN, 2)
    arrow(c, 360, diag_top - 265, 360, diag_top - 290, TEAL, 2)
    arrow(c, 470, diag_top - 265, 470, diag_top - 290, ORANGE, 2)

    # Layer 3: Data
    rounded_rect(c, 150, diag_top - 375, 410, 75, r=8, fill=HexColor('#e8f5e9'), stroke=GREEN, stroke_width=2)
    c.setFillColor(HexColor('#1b5e20'))
    c.setFont("Helvetica-Bold", 10)
    c.drawString(160, diag_top - 298, "DATA LAYER")

    draw_box(c, 160, diag_top - 340, 120, 30, "PostgreSQL", "Semantic layer", GREEN, white, 8)
    draw_box(c, 295, diag_top - 340, 120, 30, "Neo4j", "Knowledge graph", TEAL, white, 8)
    draw_box(c, 430, diag_top - 340, 120, 30, "Source DBs", "Postgres/SQLite", ORANGE, white, 8)

    c.setFillColor(TEXT_LIGHT)
    c.setFont("Helvetica", 7)
    c.drawRightString(555, diag_top - 370, "Definitions | KPIs | Logs | Relationships | Client Data")

    # Claude API box (external)
    draw_box(c, 30, diag_top - 195, 110, 35, "Claude API", "claude-sonnet-4-6", ACCENT, white, 8)
    arrow(c, 140, diag_top - 177, 160, diag_top - 172, ACCENT, 1.5)

    # Legend
    y_legend = diag_top - 410
    c.setFillColor(TEXT_DARK)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(30, y_legend, "Key Components:")
    c.setFont("Helvetica", 8)
    c.setFillColor(TEXT_MID)
    items = [
        ("Frontend:", "8 pages — login, setup wizard, chat query, dashboards, reports, semantic definitions, gaps/logs, user management"),
        ("Backend:", "Express API with JWT auth, AI service, connector pool, schema profiler, query engine with repair loop"),
        ("Data:", "PostgreSQL stores metadata + semantic layer. Neo4j stores knowledge graph. Source DBs hold client business data."),
        ("AI:", "All Claude calls route through AIService.ts — schema drafts, NL-to-SQL, answer formatting, dashboard specs, report narratives"),
    ]
    for label, desc in items:
        y_legend -= 16
        c.setFont("Helvetica-Bold", 8)
        c.drawString(40, y_legend, label)
        c.setFont("Helvetica", 8)
        c.drawString(40 + c.stringWidth(label, "Helvetica-Bold", 8) + 4, y_legend, desc)

    page_footer(c, page_num)
    c.showPage()

    # =========================================================================
    # PAGE 3 — AZURE INFRASTRUCTURE
    # =========================================================================
    page_num += 1
    y = H - 20
    y = section_header(c, y, "Azure Infrastructure", 2)

    c.setFillColor(TEXT_MID)
    c.setFont("Helvetica", 9)
    c.drawString(30, y, "All services run in Azure West Europe (Netherlands). Container Apps scale to zero when idle for cost optimization.")
    y -= 30

    # Azure Resource Group box
    rounded_rect(c, 20, y - 430, W - 40, 440, r=10, fill=HexColor('#f3f4f6'), stroke=HexColor('#2196f3'), stroke_width=2)
    c.setFillColor(HexColor('#1565c0'))
    c.setFont("Helvetica-Bold", 11)
    c.drawString(35, y - 5, "Resource Group: databridge-prod-rg")

    # Container Apps Environment
    rounded_rect(c, 35, y - 225, 340, 200, r=8, fill=HexColor('#e3f2fd'), stroke=HexColor('#42a5f5'), stroke_width=1.5)
    c.setFillColor(HexColor('#1565c0'))
    c.setFont("Helvetica-Bold", 9)
    c.drawString(45, y - 32, "Container Apps Environment")

    # Public-facing apps
    c.setFillColor(TEXT_LIGHT)
    c.setFont("Helvetica", 7)
    c.drawString(45, y - 48, "PUBLIC (HTTPS)")

    draw_box(c, 45, y - 90, 145, 35, "Frontend", "Next.js | 0.25 CPU", HexColor('#1976d2'), white, 8)
    draw_box(c, 200, y - 90, 165, 35, "Backend", "Express | 0.5 CPU", HexColor('#1976d2'), white, 8)

    # Scale-to-zero badges
    c.setFillColor(GREEN)
    c.setFont("Helvetica-Bold", 6)
    rounded_rect(c, 105, y - 95, 55, 12, r=3, fill=GREEN)
    c.setFillColor(white)
    c.drawCentredString(132.5, y - 93, "SCALE-TO-0")
    c.setFillColor(GREEN)
    rounded_rect(c, 275, y - 95, 55, 12, r=3, fill=GREEN)
    c.setFillColor(white)
    c.drawCentredString(302.5, y - 93, "SCALE-TO-0")

    # Internal-only apps
    c.setFillColor(TEXT_LIGHT)
    c.setFont("Helvetica", 7)
    c.drawString(45, y - 115, "INTERNAL ONLY")

    draw_box(c, 45, y - 155, 145, 35, "Neo4j", "Graph DB | 0.5 CPU", HexColor('#00695c'), white, 8)
    draw_box(c, 200, y - 155, 165, 35, "ETL Worker", "Python | 0.5 CPU", HexColor('#00695c'), white, 8)

    rounded_rect(c, 105, y - 160, 55, 12, r=3, fill=GREEN)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 6)
    c.drawCentredString(132.5, y - 158, "SCALE-TO-0")
    rounded_rect(c, 275, y - 160, 55, 12, r=3, fill=GREEN)
    c.setFillColor(white)
    c.drawCentredString(302.5, y - 158, "SCALE-TO-0")

    # File share
    draw_box(c, 45, y - 210, 145, 30, "Azure File Share", "Neo4j persistent data", HexColor('#455a64'), white, 7)
    arrow(c, 117, y - 155, 117, y - 180, TEAL, 1.5)

    # Right column — always-on services
    # Postgres
    draw_box(c, 395, y - 90, 155, 55, "PostgreSQL", "Flexible Server B1ms", HexColor('#2e7d32'), white, 9)
    rounded_rect(c, 455, y - 95, 60, 12, r=3, fill=ORANGE)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 6)
    c.drawCentredString(485, y - 93, "ALWAYS ON")

    c.setFillColor(TEXT_MID)
    c.setFont("Helvetica", 7)
    c.drawCentredString(472, y - 100, "~25 EUR/mo")

    # Arrow from backend to postgres
    arrow(c, 365, y - 72, 395, y - 72, GREEN, 1.5)

    # Other services
    draw_box(c, 395, y - 165, 155, 30, "Key Vault", "Secrets (JWT, API keys)", HexColor('#4a148c'), white, 8)
    draw_box(c, 395, y - 210, 155, 30, "Container Registry", "Docker images (Basic)", HexColor('#bf360c'), white, 8)
    draw_box(c, 395, y - 255, 155, 30, "Blob Storage", "Warehouse + files", HexColor('#e65100'), white, 8)
    draw_box(c, 395, y - 300, 155, 30, "Application Insights", "Monitoring & logs", HexColor('#0277bd'), white, 8)

    # Internet arrow
    c.setFillColor(TEXT_DARK)
    c.setFont("Helvetica-Bold", 9)
    c.drawCentredString(210, y - 260, "Internet")
    arrow(c, 210, y - 270, 210, y - 295, HexColor('#f44336'), 2)

    # Firewall
    rounded_rect(c, 140, y - 320, 140, 22, r=4, fill=HexColor('#ff5722'))
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 8)
    c.drawCentredString(210, y - 313, "HTTPS / Firewall")

    arrow(c, 210, y - 320, 210, y - 350, HexColor('#f44336'), 2)

    c.setFillColor(TEXT_MID)
    c.setFont("Helvetica", 8)
    c.drawCentredString(210, y - 360, "Users access Frontend + Backend via HTTPS")
    c.drawCentredString(210, y - 372, "Neo4j + ETL are internal only (no public URL)")

    # Cost summary box
    rounded_rect(c, 35, y - 420, 520, 60, r=6, fill=HexColor('#fff3e0'), stroke=AMBER, stroke_width=1)
    c.setFillColor(ORANGE)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(50, y - 380, "Cost Summary")
    c.setFillColor(TEXT_DARK)
    c.setFont("Helvetica", 9)
    c.drawString(50, y - 396, "Idle (no traffic):  ~30 EUR/month")
    c.drawString(50, y - 410, "Active (with usage):  ~50-60 EUR/month")
    c.drawString(300, y - 396, "PostgreSQL is the main cost (~25 EUR/mo)")
    c.drawString(300, y - 410, "Container Apps cost 0 EUR when scaled to zero")

    page_footer(c, page_num)
    c.showPage()

    # =========================================================================
    # PAGE 4 — DATA FLOW ARCHITECTURE
    # =========================================================================
    page_num += 1
    y = H - 20
    y = section_header(c, y, "Data Flow Architecture", 3)
    y -= 10

    # Flow 1: Setup
    c.setFillColor(DARK_BLUE)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(30, y, "Flow 1: Setup & Schema Profiling")
    y -= 10

    rounded_rect(c, 25, y - 65, W - 50, 65, r=6, fill=HexColor('#ede7f6'), stroke=PURPLE, stroke_width=1)

    bw, bh = 85, 32
    sx = 35
    draw_box(c, sx, y - 50, bw, bh, "Connect DB", "Admin", PURPLE, white, 7)
    sx += bw + 5; arrow(c, sx - 5, y - 34, sx, y - 34, PURPLE, 1.5)
    draw_box(c, sx, y - 50, bw, bh, "Introspect", "Schema+samples", PURPLE, white, 7)
    sx += bw + 5; arrow(c, sx - 5, y - 34, sx, y - 34, PURPLE, 1.5)
    draw_box(c, sx, y - 50, bw, bh, "Claude AI", "Draft definitions", ACCENT, white, 7)
    sx += bw + 5; arrow(c, sx - 5, y - 34, sx, y - 34, PURPLE, 1.5)
    draw_box(c, sx, y - 50, bw, bh, "Admin Review", "Confirm/edit", PURPLE, white, 7)
    sx += bw + 5; arrow(c, sx - 5, y - 34, sx, y - 34, PURPLE, 1.5)
    draw_box(c, sx, y - 50, bw + 15, bh, "Save to PG+Neo4j", "Semantic layer", GREEN, white, 7)

    y -= 85

    # Flow 2: Query
    c.setFillColor(DARK_BLUE)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(30, y, "Flow 2: Natural Language Query")
    y -= 10

    rounded_rect(c, 25, y - 95, W - 50, 95, r=6, fill=HexColor('#e3f2fd'), stroke=LIGHT_BLUE, stroke_width=1)

    # Top row
    sx = 35
    draw_box(c, sx, y - 40, 100, 28, "User Question", "Plain language", LIGHT_BLUE, white, 7)
    sx += 105; arrow(c, sx - 5, y - 26, sx, y - 26, MID_BLUE, 1.5)
    draw_box(c, sx, y - 40, 100, 28, "Fetch Context", "Semantic layer", MID_BLUE, white, 7)
    sx += 105; arrow(c, sx - 5, y - 26, sx, y - 26, MID_BLUE, 1.5)
    draw_box(c, sx, y - 40, 100, 28, "Claude NL->SQL", "Generate + score", ACCENT, white, 7)
    sx += 105; arrow(c, sx - 5, y - 26, sx, y - 26, MID_BLUE, 1.5)
    draw_box(c, sx, y - 40, 100, 28, "Confidence Gate", ">= 0.70?", AMBER, white, 7)

    # Bottom row — two paths
    # YES path
    draw_box(c, 350, y - 82, 85, 25, "Execute SQL", "Source DB", GREEN, white, 7)
    arrow(c, 400, y - 40, 400, y - 57, GREEN, 1.5)
    arrow(c, 435, y - 69, 445, y - 69, GREEN, 1.5)
    draw_box(c, 445, y - 82, 95, 25, "Format Answer", "Claude AI", GREEN, white, 7)

    # NO path
    draw_box(c, 35, y - 82, 95, 25, "Block + Log Gap", "Definition gap", RED, white, 7)
    arrow(c, 350, y - 40, 82, y - 57, RED, 1.5)

    # Labels
    c.setFillColor(GREEN)
    c.setFont("Helvetica-Bold", 7)
    c.drawString(408, y - 50, "YES")
    c.setFillColor(RED)
    c.drawString(175, y - 52, "NO (<0.70)")

    y -= 115

    # Flow 3: Dashboard
    c.setFillColor(DARK_BLUE)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(30, y, "Flow 3: AI Dashboard Generation")
    y -= 10

    rounded_rect(c, 25, y - 65, W - 50, 65, r=6, fill=HexColor('#fce4ec'), stroke=HexColor('#e91e63'), stroke_width=1)

    sx = 35
    draw_box(c, sx, y - 50, 100, bh, "Describe", "\"Show sales trends\"", HexColor('#e91e63'), white, 7)
    sx += 105; arrow(c, sx - 5, y - 34, sx, y - 34, HexColor('#e91e63'), 1.5)
    draw_box(c, sx, y - 50, 100, bh, "Refine Q&A", "3-4 questions", HexColor('#c2185b'), white, 7)
    sx += 105; arrow(c, sx - 5, y - 34, sx, y - 34, HexColor('#e91e63'), 1.5)
    draw_box(c, sx, y - 50, 100, bh, "Claude Spec", "JSON widgets", ACCENT, white, 7)
    sx += 105; arrow(c, sx - 5, y - 34, sx, y - 34, HexColor('#e91e63'), 1.5)
    draw_box(c, sx, y - 50, 100, bh, "Render", "Recharts + filters", HexColor('#e91e63'), white, 7)

    y -= 85

    # Flow 4: Report
    c.setFillColor(DARK_BLUE)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(30, y, "Flow 4: KPI Report Builder")
    y -= 10

    rounded_rect(c, 25, y - 65, W - 50, 65, r=6, fill=HexColor('#e8f5e9'), stroke=GREEN, stroke_width=1)

    sx = 35
    draw_box(c, sx, y - 50, 100, bh, "Select KPIs", "Pick metrics", GREEN, white, 7)
    sx += 105; arrow(c, sx - 5, y - 34, sx, y - 34, GREEN, 1.5)
    draw_box(c, sx, y - 50, 100, bh, "Execute SQL", "Parallel queries", HexColor('#2e7d32'), white, 7)
    sx += 105; arrow(c, sx - 5, y - 34, sx, y - 34, GREEN, 1.5)
    draw_box(c, sx, y - 50, 100, bh, "Chart Render", "Bar charts", HexColor('#388e3c'), white, 7)
    sx += 105; arrow(c, sx - 5, y - 34, sx, y - 34, GREEN, 1.5)
    draw_box(c, sx, y - 50, 100, bh, "AI Narrative", "4 sentence summary", ACCENT, white, 7)

    page_footer(c, page_num)
    c.showPage()

    # =========================================================================
    # PAGE 5 — SEMANTIC LAYER + AI ARCHITECTURE
    # =========================================================================
    page_num += 1
    y = H - 20
    y = section_header(c, y, "Semantic Layer & AI Architecture", 4)
    y -= 10

    # Semantic layer data model
    c.setFillColor(DARK_BLUE)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(30, y, "Semantic Layer Data Model")
    y -= 15

    # PostgreSQL section
    rounded_rect(c, 25, y - 165, 260, 165, r=8, fill=HexColor('#e8f5e9'), stroke=GREEN, stroke_width=1.5)
    c.setFillColor(GREEN)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(35, y - 10, "PostgreSQL (always-on)")

    pg_tables = [
        ("connections", "Source DB configs"),
        ("query_log", "Every question + SQL"),
        ("definition_gaps", "Unresolvable queries"),
        ("dashboards", "Dashboard configs"),
        ("rule_executions", "Quality rule runs"),
        ("quality_failures", "Failed quality checks"),
        ("quality_score_history", "Score trends"),
        ("dataset_profiles", "Table statistics"),
    ]
    ty = y - 28
    for name, desc in pg_tables:
        rounded_rect(c, 35, ty - 2, 240, 15, r=3, fill=HexColor('#c8e6c9'))
        c.setFillColor(HexColor('#1b5e20'))
        c.setFont("Helvetica-Bold", 7)
        c.drawString(40, ty, name)
        c.setFont("Helvetica", 7)
        c.setFillColor(TEXT_MID)
        c.drawString(160, ty, desc)
        ty -= 17

    # Neo4j section
    rounded_rect(c, 300, y - 165, 260, 165, r=8, fill=HexColor('#e0f2f1'), stroke=TEAL, stroke_width=1.5)
    c.setFillColor(TEAL)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(310, y - 10, "Neo4j (knowledge graph)")

    neo_tables = [
        ("source_tables", "Table definitions"),
        ("source_columns", "Column definitions"),
        ("table_relationships", "Joins / FKs"),
        ("kpi_definitions", "Business metrics"),
        ("cross_source_views", "Multi-source views"),
        ("quality_rules", "Data quality rules"),
    ]
    ty = y - 28
    for name, desc in neo_tables:
        rounded_rect(c, 310, ty - 2, 240, 15, r=3, fill=HexColor('#b2dfdb'))
        c.setFillColor(HexColor('#004d40'))
        c.setFont("Helvetica-Bold", 7)
        c.drawString(315, ty, name)
        c.setFont("Helvetica", 7)
        c.setFillColor(TEXT_MID)
        c.drawString(430, ty, desc)
        ty -= 17

    # Arrow between them
    arrow(c, 285, y - 82, 300, y - 82, MID_BLUE, 1.5)
    c.setFillColor(MID_BLUE)
    c.setFont("Helvetica", 6)

    y -= 195

    # AI Architecture
    c.setFillColor(DARK_BLUE)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(30, y, "AI Architecture — All calls through AIService.ts")
    y -= 15

    # AIService central box
    rounded_rect(c, 25, y - 280, W - 50, 280, r=8, fill=HexColor('#f3e5f5'), stroke=ACCENT, stroke_width=1.5)

    # Central AIService
    draw_box(c, W/2 - 75, y - 10, 150, 35, "AIService.ts", "Single entry point", ACCENT, white, 10)

    # Claude API
    draw_box(c, W/2 + 120, y - 10, 120, 35, "Claude API", "claude-sonnet-4-6", HexColor('#311b92'), white, 8)
    arrow(c, W/2 + 75, y + 8, W/2 + 120, y + 8, ACCENT, 2)

    # Three call types
    # Call Type 1
    rounded_rect(c, 35, y - 105, 160, 80, r=6, fill=HexColor('#e8eaf6'), stroke=LIGHT_BLUE, stroke_width=1)
    c.setFillColor(DARK_BLUE)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(45, y - 35, "Call Type 1: Schema Draft")
    c.setFillColor(TEXT_MID)
    c.setFont("Helvetica", 7)
    c.drawString(45, y - 50, "When: Setup phase (once)")
    c.drawString(45, y - 62, "Input: Schema + sample values")
    c.drawString(45, y - 74, "Output: Draft definitions (JSON)")
    c.drawString(45, y - 86, "Stored with ai_draft: true")
    c.drawString(45, y - 98, "Admin confirms before active")
    arrow(c, 115, y - 10, 115, y - 25, LIGHT_BLUE, 1.5)

    # Call Type 2
    rounded_rect(c, 210, y - 105, 170, 80, r=6, fill=HexColor('#fce4ec'), stroke=HexColor('#e91e63'), stroke_width=1)
    c.setFillColor(HexColor('#880e4f'))
    c.setFont("Helvetica-Bold", 9)
    c.drawString(220, y - 35, "Call Type 2: NL -> SQL")
    c.setFillColor(TEXT_MID)
    c.setFont("Helvetica", 7)
    c.drawString(220, y - 50, "When: Every user question")
    c.drawString(220, y - 62, "2a: Generate SQL + confidence")
    c.drawString(220, y - 74, "2b: Format result as plain text")
    c.drawString(220, y - 86, "Gate: score >= 0.70 to execute")
    c.drawString(220, y - 98, "Below 0.70: block + log gap")
    arrow(c, W/2, y - 10, W/2, y - 25, HexColor('#e91e63'), 1.5)

    # Call Type 3
    rounded_rect(c, 395, y - 105, 155, 80, r=6, fill=HexColor('#e8f5e9'), stroke=GREEN, stroke_width=1)
    c.setFillColor(HexColor('#1b5e20'))
    c.setFont("Helvetica-Bold", 9)
    c.drawString(405, y - 35, "Call Type 3: Narrative")
    c.setFillColor(TEXT_MID)
    c.setFont("Helvetica", 7)
    c.drawString(405, y - 50, "When: Report generation")
    c.drawString(405, y - 62, "Input: KPI results + period")
    c.drawString(405, y - 74, "Output: 4-sentence summary")
    c.drawString(405, y - 86, "Business-friendly language")
    c.drawString(405, y - 98, "No technical terms")
    arrow(c, 472, y - 10, 472, y - 25, GREEN, 1.5)

    # Confidence gate diagram
    c.setFillColor(DARK_BLUE)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(45, y - 125, "Confidence Score Gate (Call Type 2)")

    # Gate diagram
    rounded_rect(c, 35, y - 200, 120, 55, r=5, fill=AMBER)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 10)
    c.drawCentredString(95, y - 155, "Confidence")
    c.drawCentredString(95, y - 170, "Score")
    c.setFont("Helvetica", 8)
    c.drawCentredString(95, y - 188, "0.00 - 1.00")

    # >= 0.70
    arrow(c, 155, y - 160, 210, y - 160, GREEN, 2)
    draw_box(c, 210, y - 180, 100, 35, "EXECUTE", "Run SQL query", GREEN, white, 8)
    arrow(c, 310, y - 162, 340, y - 162, GREEN, 1.5)
    draw_box(c, 340, y - 180, 100, 35, "FORMAT", "Plain language", GREEN, white, 8)

    c.setFillColor(GREEN)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(162, y - 153, ">= 0.70")

    # < 0.70
    arrow(c, 155, y - 190, 210, y - 225, RED, 2)
    draw_box(c, 210, y - 245, 100, 35, "BLOCK", "Don't execute", RED, white, 8)
    arrow(c, 310, y - 227, 340, y - 227, RED, 1.5)
    draw_box(c, 340, y - 245, 100, 35, "LOG GAP", "Flag for admin", RED, white, 8)

    c.setFillColor(RED)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(162, y - 210, "< 0.70")

    # User message for blocked
    rounded_rect(c, 450, y - 245, 100, 35, r=5, fill=HexColor('#ffebee'), stroke=RED, stroke_width=1)
    c.setFillColor(RED)
    c.setFont("Helvetica", 6)
    c.drawCentredString(500, y - 222, "\"I don't have enough")
    c.drawCentredString(500, y - 232, "context to answer")
    c.drawCentredString(500, y - 242, "confidently yet.\"")
    arrow(c, 440, y - 227, 450, y - 227, RED, 1)

    page_footer(c, page_num)
    c.showPage()

    # =========================================================================
    # PAGE 6 — CI/CD + TECH STACK + SECURITY
    # =========================================================================
    page_num += 1
    y = H - 20
    y = section_header(c, y, "CI/CD Pipeline", 5)
    y -= 10

    rounded_rect(c, 25, y - 100, W - 50, 100, r=8, fill=HexColor('#e8eaf6'), stroke=MID_BLUE, stroke_width=1.5)

    # Pipeline steps
    steps = [
        ("Developer", "git push main", HexColor('#37474f')),
        ("GitHub", "Actions trigger", HexColor('#24292e')),
        ("Build", "Docker images x3", HexColor('#e65100')),
        ("Push", "to ACR", HexColor('#bf360c')),
        ("Deploy", "Container Apps", HexColor('#1565c0')),
        ("Migrate", "Knex + Neo4j", GREEN),
    ]

    sx = 35
    step_w = 80
    for i, (name, desc, col) in enumerate(steps):
        draw_box(c, sx, y - 55, step_w, 35, name, desc, col, white, 7)
        if i < len(steps) - 1:
            arrow(c, sx + step_w, y - 37, sx + step_w + 8, y - 37, col, 1.5)
        sx += step_w + 8

    # Three services
    c.setFillColor(TEXT_MID)
    c.setFont("Helvetica", 8)
    c.drawString(35, y - 80, "Services built:  backend (Node.js)  |  frontend (Next.js)  |  etl (Python)")
    c.drawString(35, y - 92, "Auto-deploys on every push to main. ~5 minutes end-to-end.")

    y -= 130

    # Tech Stack
    y = section_header(c, y + 15, "Tech Stack", 6)
    y -= 8

    # Table
    col_widths = [120, 200, 215]
    headers = ["Category", "Technology", "Purpose"]

    # Header row
    rounded_rect(c, 25, y - 18, sum(col_widths), 18, r=0, fill=DARK_BLUE)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 8)
    cx = 30
    for i, h in enumerate(headers):
        c.drawString(cx, y - 13, h)
        cx += col_widths[i]
    y -= 18

    rows = [
        ("Frontend", "Next.js 14, Tailwind CSS", "App Router, SSR, responsive UI"),
        ("", "Recharts", "Interactive charts & dashboards"),
        ("", "Axios", "API client with auth interceptor"),
        ("Backend", "Express.js + TypeScript", "REST API, middleware, routes"),
        ("", "Knex.js", "Query builder for PG + SQLite"),
        ("", "@anthropic-ai/sdk", "Claude API integration"),
        ("Databases", "PostgreSQL 16", "Semantic layer, metadata, logs"),
        ("", "Neo4j 5 Community", "Knowledge graph (relationships)"),
        ("", "Source: Postgres/SQLite", "Client business data (read-only)"),
        ("AI", "Claude claude-sonnet-4-6", "NL-SQL, schema drafts, narratives"),
        ("Infrastructure", "Azure Container Apps", "Scale-to-zero containers"),
        ("", "Terraform", "Infrastructure as Code"),
        ("", "GitHub Actions", "CI/CD pipeline"),
        ("Auth", "JWT + bcrypt", "Token auth, password hashing"),
    ]

    for i, (cat, tech, purpose) in enumerate(rows):
        bg = BG_GRAY if i % 2 == 0 else white
        rounded_rect(c, 25, y - 15, sum(col_widths), 15, r=0, fill=bg)
        cx = 30
        if cat:
            c.setFillColor(DARK_BLUE)
            c.setFont("Helvetica-Bold", 7)
        else:
            c.setFillColor(TEXT_MID)
            c.setFont("Helvetica", 7)
        c.drawString(cx, y - 11, cat)
        cx += col_widths[0]
        c.setFillColor(TEXT_DARK)
        c.setFont("Helvetica-Bold", 7)
        c.drawString(cx, y - 11, tech)
        cx += col_widths[1]
        c.setFillColor(TEXT_MID)
        c.setFont("Helvetica", 7)
        c.drawString(cx, y - 11, purpose)
        y -= 15

    y -= 20

    # Security
    y = section_header(c, y + 15, "Security", 7)
    y -= 10

    security_items = [
        ("Authentication", "JWT tokens with 8h expiry, bcrypt password hashing, role-based access (admin/client)"),
        ("Encryption", "AES-256 encryption for database credentials at rest, SSL/TLS for all connections"),
        ("Secrets", "Azure Key Vault stores JWT secret, Anthropic API key, encryption key — never in code"),
        ("Network", "Neo4j + ETL are internal-only (no public URL). Postgres firewall restricts IP access"),
        ("Data Safety", "Source databases are read-only. AI never modifies client data. SQL validated before execution"),
        ("Monitoring", "Application Insights tracks errors, response times. Query log captures every AI-generated SQL"),
    ]

    for title, desc in security_items:
        rounded_rect(c, 30, y - 28, 8, 8, r=2, fill=GREEN)
        c.setFillColor(TEXT_DARK)
        c.setFont("Helvetica-Bold", 8)
        c.drawString(45, y - 26, title)
        c.setFillColor(TEXT_MID)
        c.setFont("Helvetica", 7.5)
        c.drawString(130, y - 26, desc)
        y -= 22

    page_footer(c, page_num)
    c.showPage()

    # =========================================================================
    # PAGE 7 — COST + ROLES
    # =========================================================================
    page_num += 1
    y = H - 20
    y = section_header(c, y, "Cost Breakdown & Roles", 8)
    y -= 10

    # Cost table
    c.setFillColor(DARK_BLUE)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(30, y, "Monthly Cost Breakdown (EUR)")
    y -= 20

    cost_headers = ["Component", "Idle Cost", "Active Cost", "Notes"]
    cost_widths = [150, 80, 80, 225]

    rounded_rect(c, 25, y - 18, sum(cost_widths), 18, r=0, fill=DARK_BLUE)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 8)
    cx = 30
    for i, h in enumerate(cost_headers):
        c.drawString(cx, y - 13, h)
        cx += cost_widths[i]
    y -= 18

    cost_rows = [
        ("PostgreSQL Flexible Server", "~25", "~25", "B1ms (1 vCPU, 2GB) — always on"),
        ("Container Apps: Backend", "0", "~8-12", "0.5 CPU, 1GB — scale-to-zero"),
        ("Container Apps: Frontend", "0", "~3-5", "0.25 CPU, 0.5GB — scale-to-zero"),
        ("Container Apps: Neo4j", "0", "~5-8", "0.5 CPU, 1GB — scale-to-zero"),
        ("Container Apps: ETL", "0", "~3-5", "0.5 CPU, 1GB — scale-to-zero"),
        ("Container Registry (ACR)", "~5", "~5", "Basic tier — stores Docker images"),
        ("Blob Storage", "<1", "~1-2", "LRS — warehouse + Neo4j file share"),
        ("Key Vault", "0", "<1", "Standard tier — low usage free"),
        ("Application Insights", "0", "~1-2", "First 5GB/month free"),
        ("TOTAL", "~30", "~50-60", ""),
    ]

    for i, (comp, idle, active, notes) in enumerate(cost_rows):
        is_total = comp == "TOTAL"
        bg = DARK_BLUE if is_total else (BG_GRAY if i % 2 == 0 else white)
        rounded_rect(c, 25, y - 16, sum(cost_widths), 16, r=0, fill=bg)
        cx = 30
        text_col = white if is_total else TEXT_DARK
        c.setFillColor(text_col)
        c.setFont("Helvetica-Bold" if is_total else "Helvetica", 8)
        c.drawString(cx, y - 12, comp)
        cx += cost_widths[0]
        c.drawString(cx, y - 12, idle)
        cx += cost_widths[1]
        c.drawString(cx, y - 12, active)
        cx += cost_widths[2]
        c.setFont("Helvetica", 7)
        if not is_total:
            c.setFillColor(TEXT_LIGHT)
        c.drawString(cx, y - 12, notes)
        y -= 16

    y -= 25

    # Roles & Permissions
    c.setFillColor(DARK_BLUE)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(30, y, "Roles & Permissions")
    y -= 20

    role_headers = ["Feature", "Admin", "Client User"]
    role_widths = [280, 100, 100]

    rounded_rect(c, 25, y - 18, sum(role_widths), 18, r=0, fill=DARK_BLUE)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 8)
    cx = 30
    for i, h in enumerate(role_headers):
        c.drawString(cx, y - 13, h)
        cx += role_widths[i]
    y -= 18

    role_rows = [
        ("Connect data source", True, False),
        ("Run schema introspection", True, False),
        ("Review / confirm definitions", True, False),
        ("Add / edit KPI definitions", True, False),
        ("View definition gaps", True, False),
        ("Ask questions (chat)", True, True),
        ("Build and view reports & dashboards", True, True),
        ("View full query log", True, False),
        ("See SQL toggle (show query)", True, False),
        ("Manage users", True, False),
    ]

    for i, (feature, admin, client) in enumerate(role_rows):
        bg = BG_GRAY if i % 2 == 0 else white
        rounded_rect(c, 25, y - 16, sum(role_widths), 16, r=0, fill=bg)
        c.setFillColor(TEXT_DARK)
        c.setFont("Helvetica", 8)
        c.drawString(30, y - 12, feature)
        # Checkmarks
        for val, offset in [(admin, 330), (client, 430)]:
            if val:
                c.setFillColor(GREEN)
                c.setFont("Helvetica-Bold", 10)
                c.drawCentredString(offset, y - 13, "Y")
            else:
                c.setFillColor(HexColor('#e0e0e0'))
                c.setFont("Helvetica", 10)
                c.drawCentredString(offset, y - 13, "-")
        y -= 16

    y -= 30

    # Final note
    rounded_rect(c, 25, y - 50, W - 50, 50, r=6, fill=HexColor('#e8eaf6'), stroke=MID_BLUE, stroke_width=1)
    c.setFillColor(DARK_BLUE)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(40, y - 18, "Deployment")
    c.setFillColor(TEXT_MID)
    c.setFont("Helvetica", 8)
    c.drawString(40, y - 32, "Frontend: https://databridge-prod-frontend.happysand-8549b35c.westeurope.azurecontainerapps.io")
    c.drawString(40, y - 44, "Backend:  https://databridge-prod-backend.happysand-8549b35c.westeurope.azurecontainerapps.io")

    page_footer(c, page_num)
    c.showPage()

    # Save
    c.save()
    print("PDF created: Clarion_Architecture.pdf")

if __name__ == '__main__':
    create_pdf()
