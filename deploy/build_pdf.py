"""Genera GUIDA_XAUBOT.pdf da GUIDA_XAUBOT.md usando ReportLab."""
import re
from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak,
    Table, TableStyle, Preformatted, KeepTogether
)
from reportlab.lib.enums import TA_LEFT

SRC = Path(__file__).parent.parent / "GUIDA_XAUBOT.md"
DST = Path(__file__).parent.parent / "GUIDA_XAUBOT.pdf"

styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=styles["Heading1"], fontSize=20, spaceAfter=14,
                   textColor=colors.HexColor("#0b3d91"), fontName="Helvetica-Bold")
H2 = ParagraphStyle("H2", parent=styles["Heading2"], fontSize=15, spaceBefore=14,
                    spaceAfter=10, textColor=colors.HexColor("#0b3d91"), fontName="Helvetica-Bold")
H3 = ParagraphStyle("H3", parent=styles["Heading3"], fontSize=12, spaceBefore=10,
                    spaceAfter=6, textColor=colors.HexColor("#333333"), fontName="Helvetica-Bold")
BODY = ParagraphStyle("Body", parent=styles["BodyText"], fontSize=10, leading=14,
                      alignment=TA_LEFT, spaceAfter=6)
QUOTE = ParagraphStyle("Quote", parent=BODY, leftIndent=14, textColor=colors.HexColor("#555555"),
                       borderColor=colors.HexColor("#cccccc"), borderWidth=0, fontName="Helvetica-Oblique")
LI = ParagraphStyle("LI", parent=BODY, leftIndent=14, bulletIndent=4, spaceAfter=2)
CODE_STYLE = ParagraphStyle("Code", parent=BODY, fontName="Courier", fontSize=8.5, leading=11,
                            leftIndent=8, rightIndent=8, backColor=colors.HexColor("#f4f4f4"),
                            borderColor=colors.HexColor("#dddddd"), borderWidth=0.5, borderPadding=6,
                            spaceBefore=4, spaceAfter=8)


def inline(text: str) -> str:
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"`([^`]+)`", r'<font name="Courier" backColor="#f0f0f0">\1</font>', text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<link href="\2" color="blue">\1</link>', text)
    text = re.sub(r"~~(.+?)~~", r'<strike>\1</strike>', text)
    text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<i>\1</i>", text)
    return text


def parse_md(md: str):
    story = []
    lines = md.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]

        # code block
        if line.startswith("```"):
            i += 1
            code = []
            while i < len(lines) and not lines[i].startswith("```"):
                code.append(lines[i])
                i += 1
            i += 1
            story.append(Preformatted("\n".join(code), CODE_STYLE))
            continue

        # heading
        if line.startswith("# "):
            story.append(Paragraph(inline(line[2:].strip()), H1))
        elif line.startswith("## "):
            story.append(Paragraph(inline(line[3:].strip()), H2))
        elif line.startswith("### "):
            story.append(Paragraph(inline(line[4:].strip()), H3))
        # horizontal rule
        elif line.strip() == "---":
            story.append(Spacer(1, 6))
        # quote
        elif line.startswith("> "):
            story.append(Paragraph(inline(line[2:].strip()), QUOTE))
        # bullet list
        elif re.match(r"^[\-\*] ", line):
            story.append(Paragraph("• " + inline(line[2:].strip()), LI))
        # numbered list
        elif re.match(r"^\d+\. ", line):
            txt = re.sub(r"^(\d+)\. ", r"<b>\1.</b> ", line)
            story.append(Paragraph(inline(txt), LI))
        # table
        elif line.strip().startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s\-:|]+\|$", lines[i+1].strip()):
            header_cells = [c.strip() for c in line.strip().strip("|").split("|")]
            i += 2
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            data = [[Paragraph(f"<b>{inline(c)}</b>", BODY) for c in header_cells]]
            for r in rows:
                data.append([Paragraph(inline(c), BODY) for c in r])
            ncols = len(header_cells)
            colw = (A4[0] - 4*cm) / ncols
            t = Table(data, colWidths=[colw]*ncols, repeatRows=1)
            t.setStyle(TableStyle([
                ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#e8eef9")),
                ("BOX", (0,0), (-1,-1), 0.5, colors.HexColor("#999999")),
                ("INNERGRID", (0,0), (-1,-1), 0.25, colors.HexColor("#cccccc")),
                ("VALIGN", (0,0), (-1,-1), "TOP"),
                ("LEFTPADDING", (0,0), (-1,-1), 4),
                ("RIGHTPADDING", (0,0), (-1,-1), 4),
                ("TOPPADDING", (0,0), (-1,-1), 4),
                ("BOTTOMPADDING", (0,0), (-1,-1), 4),
            ]))
            story.append(t)
            story.append(Spacer(1, 6))
            continue
        # blank line
        elif not line.strip():
            story.append(Spacer(1, 4))
        else:
            story.append(Paragraph(inline(line), BODY))
        i += 1
    return story


def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#888888"))
    canvas.drawString(2*cm, 1*cm, "XAUBOT — Guida installazione & utilizzo (Google Cloud Always Free)")
    canvas.drawRightString(A4[0]-2*cm, 1*cm, f"pagina {doc.page}")
    canvas.restoreState()


def main():
    md = SRC.read_text(encoding="utf-8")
    doc = SimpleDocTemplate(str(DST), pagesize=A4,
                            leftMargin=2*cm, rightMargin=2*cm,
                            topMargin=2*cm, bottomMargin=2*cm,
                            title="XAUBOT — Guida", author="XAUBot")
    doc.build(parse_md(md), onFirstPage=header_footer, onLaterPages=header_footer)
    print(f"OK -> {DST}  ({DST.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
