"""班级发展信息收集：名单导入、维护与导出 API（含改动审计日志）。"""

import json
import posixpath
import re
import zipfile
from datetime import date
from io import BytesIO
from typing import Optional
from urllib.parse import quote
from xml.etree import ElementTree as ET

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Boolean, Column, Date, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Session

from auth import create_access_token, decode_access_token
from constants import ROLE_ADMIN
from database import Base, get_db
from deps import _client_ip, _verify_token, oauth2_scheme, require_admin
from ratelimit import identity_ip


router = APIRouter(tags=["班级信息"])

_MAIN_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_DOC_REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_PKG_REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"
_MAX_UPLOAD_BYTES = 5 * 1024 * 1024
_MAX_XML_BYTES = 20 * 1024 * 1024


class ClassDevelopmentRecord(Base):
    __tablename__ = "class_development_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    student_id = Column(String(40), nullable=False, unique=True, index=True)
    name = Column(String(80), nullable=False)
    class_name = Column(String(80), nullable=True)
    league_member = Column(Boolean, nullable=True)
    league_activist = Column(Boolean, nullable=True)
    league_application_submitted = Column(Boolean, nullable=True)
    league_application_date = Column(Date, nullable=True)
    party_activist = Column(Boolean, nullable=True)
    recommended_for_party = Column(Boolean, nullable=True)
    party_application_submitted = Column(Boolean, nullable=True)
    party_application_date = Column(Date, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())


class ClassDevelopmentPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    league_member: Optional[bool] = None
    league_activist: Optional[bool] = None
    league_application_submitted: Optional[bool] = None
    league_application_date: Optional[date] = None
    party_activist: Optional[bool] = None
    recommended_for_party: Optional[bool] = None
    party_application_submitted: Optional[bool] = None
    party_application_date: Optional[date] = None


class ClassDevelopmentDeleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ids: list[int] = Field(..., min_length=1, max_length=1000)


class IdentityCheckRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, max_length=80)
    student_id: str = Field(..., min_length=1, max_length=40)


class ClassDevelopmentLog(Base):
    """操作审计：记录每次对学生名单 / 发展信息的改动（账号或学生本人）"""

    __tablename__ = "class_development_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, nullable=True)
    username = Column(String(50), nullable=False, default="")
    role = Column(String(20), nullable=False, default="")
    # 动作：import 导入 / update 编辑 / clear 清除数据 / delete 删除
    action = Column(String(20), nullable=False)
    record_id = Column(Integer, nullable=True)
    student_id = Column(String(40), nullable=True)
    student_name = Column(String(80), nullable=True)
    class_name = Column(String(80), nullable=True)
    # JSON 文本：改动详情（字段改前改后 / 导入统计 / 删除对象）
    detail = Column(Text, nullable=True)
    ip = Column(String(45), nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())


# 参与审计比对的字段：与编辑接口的入参保持一致，改一处即可
_STATUS_FIELDS = tuple(ClassDevelopmentPatch.model_fields)


def _column_index(cell_ref: str) -> int:
    letters = re.match(r"[A-Z]+", cell_ref or "")
    if not letters:
        return 0
    index = 0
    for char in letters.group(0):
        index = index * 26 + ord(char) - ord("A") + 1
    return index


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return [
        "".join(node.text or "" for node in item.iter(f"{_MAIN_NS}t"))
        for item in root.findall(f"{_MAIN_NS}si")
    ]


def _first_sheet_path(archive: zipfile.ZipFile) -> str:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    sheet = workbook.find(f"{_MAIN_NS}sheets/{_MAIN_NS}sheet")
    if sheet is None:
        raise ValueError("工作簿中没有可读取的工作表")
    relationship_id = sheet.get(f"{_DOC_REL_NS}id")
    targets = {
        rel.get("Id"): rel.get("Target")
        for rel in relationships.findall(f"{_PKG_REL_NS}Relationship")
    }
    target = targets.get(relationship_id)
    if not target:
        raise ValueError("无法读取工作簿的首个工作表")
    return target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))


def _sheet_rows(archive: zipfile.ZipFile, sheet_path: str, shared: list[str]):
    root = ET.fromstring(archive.read(sheet_path))
    sheet_data = root.find(f"{_MAIN_NS}sheetData")
    if sheet_data is None:
        return []

    rows = []
    for row in sheet_data.findall(f"{_MAIN_NS}row"):
        values = {}
        for cell in row.findall(f"{_MAIN_NS}c"):
            index = _column_index(cell.get("r", ""))
            if not index:
                continue
            cell_type = cell.get("t")
            if cell_type == "inlineStr":
                value = "".join(node.text or "" for node in cell.iter(f"{_MAIN_NS}t"))
            else:
                value_node = cell.find(f"{_MAIN_NS}v")
                value = value_node.text if value_node is not None else ""
                if cell_type == "s" and value:
                    try:
                        value = shared[int(value)]
                    except (ValueError, IndexError):
                        value = ""
                elif cell_type == "b":
                    value = "是" if value == "1" else "否"
            values[index] = value
        rows.append((int(row.get("r", "0") or 0), values))
    return rows


def _header_kind(value: object) -> Optional[str]:
    normalized = re.sub(r"[\s_./\\-]", "", str(value or "")).lower()
    if "姓名" in normalized or normalized == "name":
        return "name"
    if "学号" in normalized or normalized in {"studentid", "sid"}:
        return "student_id"
    if "班级" in normalized or normalized in {"class", "classname"}:
        return "class_name"
    return None


def _class_from_title(rows, header_row_number: int) -> Optional[str]:
    for row_number, values in rows:
        if row_number >= header_row_number:
            break
        for value in values.values():
            text = str(value or "").strip()
            if "班" not in text:
                continue
            ascii_label = re.search(r"[A-Za-z0-9_-]{2,24}班", text)
            if ascii_label:
                return ascii_label.group(0)
            prefix = text.split("班", 1)[0]
            token = re.split(r"[\s，,;；:：|/]+", prefix)[-1].strip()
            if token:
                return f"{token}班"
    return None


def parse_roster_xlsx(content: bytes) -> list[dict[str, str]]:
    """只返回姓名、学号和班级字段供名单导入使用。"""
    try:
        with zipfile.ZipFile(BytesIO(content)) as archive:
            entries = archive.infolist()
            if sum(entry.file_size for entry in entries) > _MAX_XML_BYTES:
                raise ValueError("名单文件中的工作表过大")
            shared = _shared_strings(archive)
            rows = _sheet_rows(archive, _first_sheet_path(archive), shared)
    except (zipfile.BadZipFile, KeyError, ET.ParseError) as exc:
        raise ValueError("请上传有效的 .xlsx 工作簿") from exc

    header_index = None
    columns = {}
    header_row_number = 0
    for row_number, values in rows[:40]:
        candidate = {}
        for index, value in values.items():
            kind = _header_kind(value)
            if kind:
                candidate[kind] = index
        if "name" in candidate and "student_id" in candidate:
            header_index = row_number
            header_row_number = row_number
            columns = candidate
            break
    if header_index is None:
        raise ValueError("没有找到同时包含姓名和学号的表头")

    class_name = _class_from_title(rows, header_row_number)
    records = []
    for row_number, values in rows:
        if row_number <= header_index:
            continue
        name = str(values.get(columns["name"], "") or "").strip()
        student_id = str(values.get(columns["student_id"], "") or "").strip()
        row_class = str(values.get(columns.get("class_name", -1), "") or "").strip() if "class_name" in columns else ""
        if row_class:
            class_name = row_class
        if not name and not student_id:
            continue
        if not name or not student_id:
            raise ValueError(f"第 {row_number} 行缺少姓名或学号")
        records.append({"name": name, "student_id": student_id, "class_name": class_name or ""})

    if not records:
        raise ValueError("工作表中没有学生记录")
    ids = [record["student_id"] for record in records]
    if len(ids) != len(set(ids)):
        raise ValueError("名单中存在重复学号，请检查源文件后重试")
    return records


def _serialize(record: ClassDevelopmentRecord) -> dict:
    return {
        "id": record.id,
        "name": record.name,
        "class_name": record.class_name,
        "student_id": record.student_id,
        "league_member": record.league_member,
        "league_activist": record.league_activist,
        "league_application_submitted": record.league_application_submitted,
        "league_application_date": record.league_application_date,
        "party_activist": record.party_activist,
        "recommended_for_party": record.recommended_for_party,
        "party_application_submitted": record.party_application_submitted,
        "party_application_date": record.party_application_date,
    }


def _yes_no(value: Optional[bool]) -> str:
    return "是" if value is True else "否" if value is False else "未填写"


def _application(submitted: Optional[bool], submitted_on: Optional[date]) -> str:
    if submitted is True:
        return f"是（{submitted_on.isoformat()}）" if submitted_on else "是"
    return "否" if submitted is False else "未填写"


def development_text(record: ClassDevelopmentRecord) -> str:
    """按团员分支汇总一段可读的“发展情况”文本，用于导出。"""
    if record.league_member is True:
        parts = [
            "团员",
            f"入党积极分子：{_yes_no(record.party_activist)}",
            f"推优：{_yes_no(record.recommended_for_party)}",
            f"入党申请书：{_application(record.party_application_submitted, record.party_application_date)}",
        ]
    elif record.league_member is False:
        parts = [
            "非团员",
            f"入团积极分子：{_yes_no(record.league_activist)}",
            f"入团申请书：{_application(record.league_application_submitted, record.league_application_date)}",
        ]
    else:
        return "未填写"
    return "；".join(parts)


# ============================================
# 最小 xlsx 写出（纯标准库，与读取侧同样不引入第三方依赖）
# 单元格统一用 inlineStr，省去 sharedStrings 部件
# ============================================

_XLSX_CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    '</Types>'
)

_XLSX_ROOT_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    '</Relationships>'
)

_XLSX_WORKBOOK_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    '</Relationships>'
)

_XLSX_WORKBOOK = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    '<sheets><sheet name="班级发展信息" sheetId="1" r:id="rId1"/></sheets>'
    '</workbook>'
)


def _xml_text(value: object) -> str:
    return (
        str("" if value is None else value)
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace('"', "&quot;").replace("'", "&apos;")
    )


def _sheet_xml(rows: list[list[str]], widths: list[int]) -> str:
    cols = "".join(
        f'<col min="{i + 1}" max="{i + 1}" width="{width}" customWidth="1"/>'
        for i, width in enumerate(widths)
    )
    body = []
    for row_index, row in enumerate(rows, 1):
        cells = "".join(
            f'<c r="{_column_letter(col_index)}{row_index}" t="inlineStr">'
            f'<is><t xml:space="preserve">{_xml_text(value)}</t></is></c>'
            for col_index, value in enumerate(row, 1)
        )
        body.append(f'<row r="{row_index}">{cells}</row>')
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<cols>{cols}</cols><sheetData>{"".join(body)}</sheetData></worksheet>'
    )


def _column_letter(index: int) -> str:
    letters = ""
    while index > 0:
        index, remainder = divmod(index - 1, 26)
        letters = chr(ord("A") + remainder) + letters
    return letters


def build_roster_xlsx(records: list[ClassDevelopmentRecord]) -> bytes:
    rows = [["姓名", "班级", "学号", "发展情况"]]
    rows += [
        [record.name, record.class_name or "", record.student_id, development_text(record)]
        for record in records
    ]
    sheet = _sheet_xml(rows, [14, 14, 16, 52])
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", _XLSX_CONTENT_TYPES)
        archive.writestr("_rels/.rels", _XLSX_ROOT_RELS)
        archive.writestr("xl/workbook.xml", _XLSX_WORKBOOK)
        archive.writestr("xl/_rels/workbook.xml.rels", _XLSX_WORKBOOK_RELS)
        archive.writestr("xl/worksheets/sheet1.xml", sheet)
    return buffer.getvalue()


# ============================================
# 操作审计：谁在什么时候、从哪个 IP、改了哪个学生的什么字段
# ============================================

def _json_value(value):
    """字段值转成可写进 JSON 的形式（日期转 ISO 字符串）"""
    return value.isoformat() if isinstance(value, date) else value


def _actor_of_user(user) -> dict:
    """审计操作人：登录账号"""
    return {"id": user.id, "username": user.username, "role": user.role}


def _actor_of(viewer: dict) -> dict:
    """审计操作人：管理员/普通账号记用户名，学生本人记姓名"""
    if viewer["kind"] == "student":
        return {"id": None, "username": viewer["student"].name, "role": "student"}
    return _actor_of_user(viewer["user"])


def _log_change(
    db: Session,
    actor: dict,
    action: str,
    request: Request,
    *,
    record: Optional[ClassDevelopmentRecord] = None,
    class_name: Optional[str] = None,
    detail: Optional[dict] = None,
) -> None:
    """追加一条审计日志（不提交事务，由调用方 commit）"""
    db.add(ClassDevelopmentLog(
        user_id=actor["id"],
        username=actor["username"],
        role=actor["role"],
        action=action,
        record_id=record.id if record is not None else None,
        student_id=record.student_id if record is not None else None,
        student_name=record.name if record is not None else None,
        class_name=(record.class_name if record is not None else None) or class_name,
        detail=json.dumps(detail, ensure_ascii=False) if detail else None,
        ip=_client_ip(request),
    ))


def _serialize_log(log: ClassDevelopmentLog) -> dict:
    return {
        "id": log.id,
        "user_id": log.user_id,
        "username": log.username,
        "role": log.role,
        "action": log.action,
        "record_id": log.record_id,
        "student_id": log.student_id,
        "student_name": log.student_name,
        "class_name": log.class_name,
        "detail": json.loads(log.detail) if log.detail else None,
        "ip": log.ip,
        "created_at": log.created_at.isoformat() if log.created_at else None,
    }


# ============================================
# 身份检测：学生凭“姓名 + 学号”进入，只看/只改自己那条记录
# ============================================

def _student_from_token(token: str, db: Session) -> Optional[ClassDevelopmentRecord]:
    """解析身份检测令牌；无效或对应记录已被删除时返回 None"""
    payload = decode_access_token(token)
    if not payload or payload.get("kind") != "student":
        return None
    try:
        record_id = int(payload.get("sub"))
    except (TypeError, ValueError):
        return None
    return db.query(ClassDevelopmentRecord).filter(ClassDevelopmentRecord.id == record_id).first()


def get_viewer(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> dict:
    """识别调用者：学生本人（身份检测令牌）或账号（管理员 / 普通用户）"""
    student = _student_from_token(token, db)
    if student is not None:
        return {"kind": "student", "student": student, "user": None}
    user = _verify_token(token, db)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="无效的令牌")
    return {"kind": "admin" if user.role == ROLE_ADMIN else "user", "student": None, "user": user}


def require_full_access(viewer: dict) -> None:
    """名单的查看/修改权限：学生本人只看自己，账号只有管理员能看全部"""
    if viewer["kind"] != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="权限不够")


def _serialize_student(record: ClassDevelopmentRecord) -> dict:
    return {
        "id": record.id,
        "name": record.name,
        "student_id": record.student_id,
        "class_name": record.class_name,
    }


@router.post("/api/identity-check")
def identity_check(
    payload: IdentityCheckRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """进入网站前的身份检测：姓名 + 学号与名单比对（跨班级检索），通过即签发“学生本人”令牌"""
    if not identity_ip.allow(_client_ip(request)):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="尝试过于频繁，请稍后再试")

    record = (
        db.query(ClassDevelopmentRecord)
        .filter(ClassDevelopmentRecord.student_id == payload.student_id.strip())
        .first()
    )
    if record is None or (record.name or "").strip() != payload.name.strip():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="姓名与学号不匹配，请检查后重试")

    token = create_access_token({"sub": str(record.id), "kind": "student", "name": record.name})
    return {"access_token": token, "token_type": "bearer", "student": _serialize_student(record)}


@router.get("/api/class-development")
def list_class_development(
    viewer: dict = Depends(get_viewer),
    db: Session = Depends(get_db),
):
    """管理员返回全班名单；学生本人只返回自己那条"""
    if viewer["kind"] == "student":
        return {"records": [_serialize(viewer["student"])], "total": 1, "scope": "self"}

    require_full_access(viewer)
    records = (
        db.query(ClassDevelopmentRecord)
        .order_by(ClassDevelopmentRecord.class_name, ClassDevelopmentRecord.student_id)
        .all()
    )
    return {"records": [_serialize(record) for record in records], "total": len(records), "scope": "all"}


@router.get("/api/class-development/logs")
def list_class_development_logs(
    limit: int = 100,
    _admin=Depends(require_admin),
    db: Session = Depends(get_db),
):
    """学生名单 / 发展信息的改动记录，按时间倒序（仅管理员）"""
    limit = max(1, min(limit, 1000))
    logs = (
        db.query(ClassDevelopmentLog)
        .order_by(ClassDevelopmentLog.id.desc())
        .limit(limit)
        .all()
    )
    return {"logs": [_serialize_log(log) for log in logs]}


@router.post("/api/class-development/import")
async def import_class_roster(
    request: Request,
    file: UploadFile = File(...),
    class_name: Optional[str] = Form(None),
    admin=Depends(require_admin),
    db: Session = Depends(get_db),
):
    if not file.filename or not file.filename.lower().endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="请上传 .xlsx 格式的名单")
    content = await file.read(_MAX_UPLOAD_BYTES + 1)
    if len(content) > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="名单文件不能超过 5 MB")
    try:
        roster = parse_roster_xlsx(content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # 页面选定了班级时，名单统一归入该班；未指定则沿用表格标题解析出的班级
    target_class = (class_name or "").strip()[:80]
    if target_class:
        for item in roster:
            item["class_name"] = target_class

    existing = {
        record.student_id: record
        for record in db.query(ClassDevelopmentRecord)
        .filter(ClassDevelopmentRecord.student_id.in_([item["student_id"] for item in roster]))
        .all()
    }
    added = 0
    updated = 0
    for item in roster:
        record = existing.get(item["student_id"])
        if record is None:
            db.add(ClassDevelopmentRecord(**item))
            added += 1
        else:
            record.name = item["name"]
            record.class_name = item["class_name"] or record.class_name
            updated += 1
    _log_change(
        db, _actor_of_user(admin), "import", request,
        class_name=target_class or roster[0]["class_name"],
        detail={
            "added": added,
            "updated": updated,
            "student_ids": [item["student_id"] for item in roster],
        },
    )
    db.commit()
    total = db.query(ClassDevelopmentRecord).count()
    return {"added": added, "updated": updated, "total": total}


@router.get("/api/class-development/export")
def export_class_development(
    class_name: Optional[str] = None,
    q: Optional[str] = None,
    _admin=Depends(require_admin),
    db: Session = Depends(get_db),
):
    """导出名单：姓名 / 班级 / 学号 / 发展情况。可按班级和搜索词过滤。"""
    query = db.query(ClassDevelopmentRecord)
    target_class = (class_name or "").strip()
    if target_class:
        query = query.filter(ClassDevelopmentRecord.class_name == target_class)
    records = query.order_by(
        ClassDevelopmentRecord.class_name, ClassDevelopmentRecord.student_id
    ).all()

    keyword = (q or "").strip().lower()
    if keyword:
        records = [
            record for record in records
            if keyword in (record.name or "").lower() or keyword in (record.student_id or "").lower()
        ]
    if not records:
        raise HTTPException(status_code=404, detail="没有可导出的学生记录")

    content = build_roster_xlsx(records)
    filename = f"{target_class or '班级'}-发展信息-{date.today().isoformat()}.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


@router.post("/api/class-development/delete")
def delete_class_development(
    payload: ClassDevelopmentDeleteRequest,
    request: Request,
    admin=Depends(require_admin),
    db: Session = Depends(get_db),
):
    """删除学生记录（含其发展信息）：传单个 id 即删除一人，传多个即“一键删除”（仅管理员）。"""
    records = (
        db.query(ClassDevelopmentRecord)
        .filter(ClassDevelopmentRecord.id.in_(payload.ids))
        .all()
    )
    if not records:
        raise HTTPException(status_code=404, detail="没有找到可删除的学生记录")

    for record in records:
        _log_change(db, _actor_of_user(admin), "delete", request, record=record)
    db.query(ClassDevelopmentRecord).filter(
        ClassDevelopmentRecord.id.in_([record.id for record in records])
    ).delete(synchronize_session=False)
    db.commit()
    return {"deleted": len(records)}


@router.patch("/api/class-development/{record_id}")
def update_class_development(
    record_id: int,
    payload: ClassDevelopmentPatch,
    request: Request,
    viewer: dict = Depends(get_viewer),
    db: Session = Depends(get_db),
):
    """管理员可改任意学生；学生本人只能改自己那条"""
    if viewer["kind"] == "student":
        if viewer["student"].id != record_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="权限不够")
        record = viewer["student"]
    else:
        require_full_access(viewer)
        record = db.query(ClassDevelopmentRecord).filter(ClassDevelopmentRecord.id == record_id).first()
        if record is None:
            raise HTTPException(status_code=404, detail="未找到该学生记录")

    before = {field: getattr(record, field) for field in _STATUS_FIELDS}
    values = payload.model_dump(exclude_unset=True)
    for field, value in values.items():
        setattr(record, field, value)

    if record.league_member is True:
        record.league_activist = None
        record.league_application_submitted = None
        record.league_application_date = None
    elif record.league_member is False:
        record.party_activist = None
        record.recommended_for_party = None
        record.party_application_submitted = None
        record.party_application_date = None
    else:
        record.league_activist = None
        record.league_application_submitted = None
        record.league_application_date = None
        record.party_activist = None
        record.recommended_for_party = None
        record.party_application_submitted = None
        record.party_application_date = None

    if record.league_application_submitted is not True:
        record.league_application_date = None
    if record.party_application_submitted is not True:
        record.party_application_date = None

    # 归一化可能连带清空其它分支的字段，这里按最终结果比对，改动为空则不记日志
    changes = {
        field: [_json_value(before[field]), _json_value(getattr(record, field))]
        for field in _STATUS_FIELDS
        if before[field] != getattr(record, field)
    }
    if changes:
        # 页面上的“清除数据”会把全部字段一次性置空，用它区分“编辑”与“清除”
        action = "clear" if values and all(value is None for value in values.values()) else "update"
        _log_change(db, _actor_of(viewer), action, request, record=record, detail={"changes": changes})

    db.commit()
    db.refresh(record)
    return _serialize(record)
