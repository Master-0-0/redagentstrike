"""Portable report rendering from saved finding records, without executing evidence."""
from io import BytesIO
from datetime import datetime, timezone
from xml.sax.saxutils import escape
import re
import os
from pathlib import Path
from threading import Lock

FONT_LOCK = Lock()


def pdf_font():
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from .findings import fail
    with FONT_LOCK:
        if "FindingsCJK" not in pdfmetrics.getRegisteredFontNames():
            candidates = [os.environ.get("WORKBENCH_REPORT_FONT", ""), "/Library/Fonts/Arial Unicode.ttf", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", "C:/Windows/Fonts/simsun.ttc"]
            path = next((p for p in candidates if p and Path(p).is_file()), None)
            if not path:
                fail("report_font_missing", "PDF 中文字体不可用，请配置 WORKBENCH_REPORT_FONT 为支持中文的 TrueType 字体路径", 503)
            try:
                pdfmetrics.registerFont(TTFont("FindingsCJK", path))
            except Exception:
                fail("report_font_invalid", "PDF 字体无法加载，请检查 WORKBENCH_REPORT_FONT", 503)
    return "FindingsCJK"

REVIEWS = {'pending': '待复核', 'confirmed': '已确认', 'false_positive': '误报'}
REMEDIES = {'not_started': '未开始', 'in_progress': '修复中', 'fixed': '已修复', 'retest_passed': '复测通过', 'not_applicable': '不适用'}
SEVERITIES = {'unknown': '未知', 'info': '信息', 'low': '低危', 'medium': '中危', 'high': '高危', 'critical': '严重'}


def clean(value):
    # XML cannot represent these controls. Credentials and printable text are unchanged.
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]', '\ufffd', str(value or '未填写'))


def report_evidence(archive, findings):
    """Load verified archive copies, using the same text limit as evidence previews."""
    from .findings import fail
    total = 0
    for f in findings:
        for a in f['artifacts']:
            if a.get('integrity') != 'ok':
                a['report_notice'] = '附件完整性异常，未展示内容。'
                continue
            media = a['media_type']
            is_image = media in ('image/png', 'image/jpeg')
            is_text = media.startswith('text/') or media == 'application/json'
            if not (is_image or is_text):
                a['report_notice'] = '此附件不支持正文预览，请从成果库下载原文件。'
                continue
            _, path = archive.artifact(f['id'], a['id'])
            size = a['size'] if is_image else min(a['size'], 65537)
            total += size
            if total > 100 * 1024 * 1024:
                fail('export_too_large', '报告证据超过 100 MiB，请减少所选成果后重试', 413)
            with path.open('rb') as stream:
                data = stream.read(size)
            if is_image:
                a['report_image'] = data
            else:
                a['report_text'] = data[:65536].decode('utf-8', errors='replace')
                if a['size'] > 65536:
                    a['report_notice'] = '正文仅展示前 64 KiB，与页面预览一致；完整内容请下载原附件。'


def blocks(findings):
    yield 'title', '漏洞成果报告'
    yield 'text', '本报告汇总所选成果的漏洞说明、复现步骤、人工复核状态和保存的证据内容。漏洞结论以各项人工复核状态为准。'
    yield 'text', f'成果数量：{len(findings)}　导出时间：{datetime.now(timezone.utc).isoformat(timespec="seconds")}（UTC）'
    yield 'text', '文本与图片证据在正文中展示，保留附件说明和校验信息；不支持预览的附件请从成果库下载。'
    for index, f in enumerate(findings, 1):
        yield 'page', ''
        yield 'heading', f'{index}  {f["title"]}'
        for label, value in [('成果 ID', f['id']), ('目标', f['target']), ('风险等级', SEVERITIES.get(f['severity'], f['severity'])), ('人工复核', REVIEWS.get(f['review_status'], f['review_status'])), ('修复状态', REMEDIES.get(f['remediation_status'], f['remediation_status'])), ('Agent 判断', {'suspected': '疑似', 'reproduced': '声明已复现'}.get(f['agent_assessment'], f['agent_assessment'])), ('归档时间', f['created_at']), ('版本', f['version'])]:
            yield 'text', f'{label}：{value}'
        for title, key in [('漏洞摘要', 'summary'), ('利用前提', 'preconditions')]:
            yield 'subheading', title
            yield 'text', f[key]
        yield 'subheading', '复现步骤'
        for n, step in enumerate(f['steps'], 1):
            yield 'text', f'{n}. {step["description"]}'
            if step.get('artifact_ids'):
                yield 'text', '关联证据 ID：' + ', '.join(step['artifact_ids'])
        for title, key in [('预期结果', 'expected_result'), ('实际结果', 'actual_result')]:
            yield 'subheading', title
            yield 'text', f[key]
        yield 'subheading', '证据内容'
        if not f['artifacts']:
            yield 'text', '未归档附件。'
        for a in f['artifacts']:
            yield 'text', f'{a["filename"]}（{a["kind"]}，{a["size"]} 字节）'
            yield 'text', f'证据 ID：{a["id"]}\n说明：{a.get("description") or "未填写"}\nSHA-256：{a["sha256"]}\n完整性：{"正常" if a.get("integrity") == "ok" else "异常"}'
            if 'report_text' in a:
                yield 'subheading', '附件保存内容'
                yield 'evidence', a['report_text'] or '（空文件）'
            if 'report_image' in a:
                yield 'image', a['report_image']
            if a.get('report_notice'):
                yield 'text', a['report_notice']
        yield 'subheading', '证据缺口'
        for g in f['evidence_gaps']:
            yield 'text', f'{g["category"]} · {"已解决" if g.get("resolved_at") else g["status"]}：{g["reason"]}'
        if not f['evidence_gaps']:
            yield 'text', '无已记录的证据缺口。'
        yield 'subheading', '来源'
        for s in f['sources']:
            yield 'text', ' / '.join(str(s[k]) for k in ('source_type', 'workspace_path', 'session_id', 'owner_session_id') if s.get(k))
            for fact in s.get('fact_snapshots') or []:
                yield 'text', f'{fact["id"]}：{fact["description"]}'


def render_report(findings, format):
    output = BytesIO()
    content = [(kind, text if kind == 'image' else clean(text)) for kind, text in blocks(findings)]
    if format == 'docx':
        from docx import Document
        from docx.shared import Inches, Pt, RGBColor
        from docx.oxml import OxmlElement
        from docx.oxml.ns import qn
        doc = Document()
        section = doc.sections[0]
        section.page_width, section.page_height = Inches(8.27), Inches(11.69)
        section.top_margin = section.bottom_margin = Inches(.8)
        section.left_margin = section.right_margin = Inches(.85)
        for name, size in [('Normal', 11), ('Title', 24), ('Heading 1', 18), ('Heading 2', 13)]:
            style = doc.styles[name]
            style.font.name = 'Arial Unicode MS'
            style.font.size = Pt(size)
            style.font.color.rgb = RGBColor(0, 0, 0)
            for attr in list(style.element.get_or_add_rPr().rFonts.attrib):
                if attr.endswith("Theme"):
                    del style.element.get_or_add_rPr().rFonts.attrib[attr]
            style.element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'), 'Arial Unicode MS')
        for style in doc.styles:
            for border in list(style.element.iter(qn('w:pBdr'))):
                border.getparent().remove(border)
        doc.styles['Normal'].paragraph_format.space_after = Pt(4)
        doc.styles['Normal'].paragraph_format.line_spacing = Pt(14)
        doc.styles['Title'].paragraph_format.line_spacing = Pt(32)
        doc.styles['Heading 1'].paragraph_format.line_spacing = Pt(24)
        doc.styles['Heading 2'].paragraph_format.line_spacing = Pt(18)
        for name in ('Heading 1', 'Heading 2'):
            doc.styles[name].paragraph_format.space_before = Pt(8)
            doc.styles[name].paragraph_format.space_after = Pt(4)
        for kind, text in content:
            if kind == 'page':
                doc.add_page_break()
            elif kind == 'image':
                from PIL import Image as PILImage
                with PILImage.open(BytesIO(text)) as im:
                    width, height = im.size
                scale = min(6.5 / width, 8 / height)
                p = doc.add_paragraph()
                p.paragraph_format.line_spacing = 1.0
                p.add_run().add_picture(BytesIO(text), width=Inches(width * scale), height=Inches(height * scale))
            else:
                p = doc.add_paragraph(text, {'title': 'Title', 'heading': 'Heading 1', 'subheading': 'Heading 2'}.get(kind, 'Normal'))
                # Allow long targets, hashes and unbroken identifiers to wrap.
                wrap = OxmlElement('w:wordWrap'); wrap.set(qn('w:val'), '1')
                p._p.get_or_add_pPr().append(wrap)
                grid = OxmlElement('w:snapToGrid'); grid.set(qn('w:val'), '0')
                p._p.get_or_add_pPr().append(grid)
        doc.save(output)
    else:
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.lib.pagesizes import A4
        from reportlab.platypus import SimpleDocTemplate, Paragraph, PageBreak, Image
        font = pdf_font()
        styles = {kind: ParagraphStyle(kind, fontName=font, fontSize=size, leading=size * 1.4, spaceAfter=6, wordWrap='CJK', splitLongWords=True, keepWithNext=kind not in ('text', 'evidence')) for kind, size in [('title', 24), ('heading', 18), ('subheading', 13), ('text', 11), ('evidence', 10)]}
        story = []
        for kind, text in content:
            if kind == 'page':
                story.append(PageBreak())
            elif kind == 'image':
                picture = Image(BytesIO(text))
                scale = min((A4[0] - 112) / picture.imageWidth, 570 / picture.imageHeight)
                picture.drawWidth = picture.imageWidth * scale
                picture.drawHeight = picture.imageHeight * scale
                story.append(picture)
            else:
                # Split long multiline evidence into paragraphs that can paginate.
                for line in text.split('\n'):
                    story.append(Paragraph((escape(line).replace(' ', '&#160;').replace('\t', '&#160;' * 4) if kind == 'evidence' else escape(line)) or '<br/>', styles[kind]))
        def footer(canvas, doc):
            canvas.setFont(font, 9)
            canvas.drawRightString(A4[0] - 56, 28, str(doc.page))
        SimpleDocTemplate(output, pagesize=A4, rightMargin=56, leftMargin=56, topMargin=52, bottomMargin=48, title='漏洞成果报告').build(story, onFirstPage=footer, onLaterPages=footer)
    return output.getvalue()
