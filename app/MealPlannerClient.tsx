"use client";

import { useState, useRef, useEffect, type CSSProperties, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import * as XLSX from "xlsx";
import { db } from "@/lib/firebase";
import { collection, onSnapshot, query, where } from "firebase/firestore";

const MEAL_TYPES = ["조식", "중식", "석식", "간식"];
const CATEGORIES = ["밥", "국", "반찬A", "반찬B", "반찬C", "반찬D"];
const DAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"];
const DIET_TYPES = ["일반식", "CA식", "당뇨식", "항암식"];

function getMonday(d: Date) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function formatDate(d: Date) {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function toISODate(d: Date) {
  // 월(getMonth)은 0부터 시작하므로 +1을 하고, 2자리로 맞춥니다.
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${dd}`;
}

function dateKey(d: Date) {
  // 위와 완전히 똑같은 구조로 수정합니다.
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${dd}`;
}

function buildKey(d: Date, diet: string, mealType: string, category: string) {
  return `${dateKey(d)}__${diet}__${mealType}__${category}`;
}

type MealUpdate = {
  key: string;
  date: Date;
  diet: string;
  mealType: string;
  category: string;
  value: string;
};

// 여러 칸을 한 번에 저장 — 서버 라우트(/api/admin/meals)를 거쳐서 저장함
// (관리자 쿠키 검증은 서버에서 하고, 실제 Firestore 쓰기는 firebase-admin이 담당)
async function commitMealUpdates(updates: MealUpdate[]) {
  const res = await fetch("/api/admin/meals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      updates: updates.map((u) => ({
        key: u.key,
        date: toISODate(u.date),
        diet: u.diet,
        mealType: u.mealType,
        category: u.category,
        value: u.value,
      })),
    }),
  });
  if (!res.ok) {
    const message = await res.text().catch(() => "");
    console.error("식단 저장에 실패했습니다.", message);
    window.alert("식단 저장에 실패했습니다. 다시 시도해주세요.");
  }
}

// 한 칸만 저장할 때 쓰는 편의 함수
async function persistMealDoc(
  key: string,
  d: Date,
  diet: string,
  mealType: string,
  category: string,
  value: string
) {
  await commitMealUpdates([{ key, date: d, diet, mealType, category, value }]);
}

export default function MealPlannerClient({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const today = new Date();
  const [weekStart, setWeekStart] = useState(getMonday(today));
  const [selectedDate, setSelectedDate] = useState(today);
  const [selectedDiet, setSelectedDiet] = useState(DIET_TYPES[0]);
  const [data, setData] = useState<Record<string, string>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // 로그인 관련 상태
  const [showLogin, setShowLogin] = useState(false);
  const [showAdminMenu, setShowAdminMenu] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loading, setLoading] = useState(false);

  // 삭제 메뉴(하루/이번주/전체) 열림 상태
  const [showDeleteMenu, setShowDeleteMenu] = useState(false);

  // 엑셀 업로드 관련 상태
  const [excelBusy, setExcelBusy] = useState(false);
  const [excelResult, setExcelResult] = useState<{ success: number; errors: string[] } | null>(
    null
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 빈칸 일괄 입력 모드 관련 상태 (기존 등록 기능과는 완전히 별도)
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkDraft, setBulkDraft] = useState<Record<string, string>>({});

  // 서버(UTC)와 브라우저(KST)의 시간대가 달라 "오늘" 계산이 어긋나면서
  // 생기는 하이드레이션 불일치(React #418)를 막기 위해, 마운트 전까지는
  // 날짜에 의존하는 실제 화면을 그리지 않습니다.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Firestore 실시간 구독: 현재 보고 있는 주간(월~일) 범위만 구독
  const [syncing, setSyncing] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  useEffect(() => {
    setSyncing(true);
    setSyncError(null);
    const startISO = toISODate(weekStart);
    const weekEndForQuery = new Date(weekStart);
    weekEndForQuery.setDate(weekStart.getDate() + 6);
    const endISO = toISODate(weekEndForQuery);

    // 디버그: 지금 어떤 범위로 구독을 거는지 확인
    console.log("[meals] 구독 시작", { startISO, endISO });

    const q = query(
      collection(db, "meals"),
      where("date", ">=", startISO),
      where("date", "<=", endISO)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        // 디버그: 실제로 몇 개의 문서를 받아왔는지 확인
        console.log(
          "[meals] 스냅샷 수신, 문서 수:",
          snapshot.size,
          snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))
        );

        const weekMap: Record<string, string> = {};
        snapshot.forEach((docSnap) => {
          const value = docSnap.data().value;
          if (typeof value === "string") weekMap[docSnap.id] = value;
        });

        setData((prev) => {
          const next = { ...prev };
          for (let i = 0; i < 7; i++) {
            const d = new Date(weekStart);
            d.setDate(weekStart.getDate() + i);
            for (const diet of DIET_TYPES) {
              for (const mealType of MEAL_TYPES) {
                for (const category of CATEGORIES) {
                  const key = buildKey(d, diet, mealType, category);
                  next[key] = weekMap[key] ?? "";
                }
              }
            }
          }
          return next;
        });
        setSyncing(false);
      },
      (err) => {
        // 디버그: 여기가 원래 조용히 삼켜지던 부분 — 이제 콘솔과 화면에 표시함
        console.error("[meals] 구독 에러:", err.code, err.message, err);
        setSyncError(`${err.code}: ${err.message}`);
        setSyncing(false);
      }
    );

    return () => unsubscribe();
  }, [weekStart]);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });
  const weekEnd = days[6];

  function goPrevWeek() {
    const d = new Date(weekStart);
    d.setDate(d.getDate() - 7);
    setWeekStart(d);
  }
  function goNextWeek() {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + 7);
    setWeekStart(d);
  }
  function goToday() {
    const t = new Date();
    setWeekStart(getMonday(t));
    setSelectedDate(t);
  }

  function cellKey(mealType: string, category: string) {
    return buildKey(selectedDate, selectedDiet, mealType, category);
  }

  function startEdit(mealType: string, category: string) {
    if (!isAdmin) return;
    const key = cellKey(mealType, category);
    setEditingKey(key);
    setDraft(data[key] ?? "");
  }

  function saveEdit(key: string) {
    setData((prev) => ({ ...prev, [key]: draft.trim() }));
    setEditingKey(null);
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setLoginError("");
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: passwordInput }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setLoginError(json.message ?? "로그인에 실패했습니다.");
        return;
      }
      setShowLogin(false);
      setPasswordInput("");
      router.refresh(); // 서버 컴포넌트가 쿠키를 다시 읽도록
    } catch {
      setLoginError("네트워크 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    await fetch("/api/admin/logout", { method: "POST" });
    setShowAdminMenu(false);
    router.refresh();
  }

  // 이번 주 전체(모든 식단 종류) 데이터를 다음 주 같은 요일로 그대로 복사
  function copyWeekToNextWeek() {
    const firestoreUpdates: MealUpdate[] = [];
    setData((prev) => {
      const next = { ...prev };
      for (let i = 0; i < 7; i++) {
        const sourceDate = new Date(weekStart);
        sourceDate.setDate(weekStart.getDate() + i);
        const targetDate = new Date(sourceDate);
        targetDate.setDate(sourceDate.getDate() + 7);

        for (const diet of DIET_TYPES) {
          for (const mealType of MEAL_TYPES) {
            for (const category of CATEGORIES) {
              const value = prev[buildKey(sourceDate, diet, mealType, category)];
              if (value) {
                const targetKey = buildKey(targetDate, diet, mealType, category);
                next[targetKey] = value;
                firestoreUpdates.push({
                  key: targetKey,
                  date: targetDate,
                  diet,
                  mealType,
                  category,
                  value,
                });
              }
            }
          }
        }
      }
      return next;
    });
    if (firestoreUpdates.length > 0) {
      void commitMealUpdates(firestoreUpdates);
    }
  }

  function handleCopyWeek() {
    const nextWeekStart = new Date(weekStart);
    nextWeekStart.setDate(weekStart.getDate() + 7);
    const nextWeekEnd = new Date(nextWeekStart);
    nextWeekEnd.setDate(nextWeekStart.getDate() + 6);

    const ok = window.confirm(
      `이번 주(${formatDate(weekStart)} ~ ${formatDate(weekEnd)}) 식단을 다음 주(${formatDate(
        nextWeekStart
      )} ~ ${formatDate(nextWeekEnd)})로 그대로 복사할까요?\n다음 주에 이미 등록된 메뉴는 덮어씌워집니다.`
    );
    if (!ok) return;
    copyWeekToNextWeek();
  }

  // 이번 주(월~일) 전체 - 모든 식단 종류 x 끼니 x 카테고리 - 를 통째로 삭제
  async function handleDeleteWeek() {
    setShowDeleteMenu(false);
    const ok = window.confirm(
      `이번 주(${formatDate(weekStart)} ~ ${formatDate(
        weekEnd
      )}) 식단 전체를 삭제할까요?\n모든 식단 종류(일반식/CA식/당뇨식/항암식)의 등록된 내용이 전부 지워지며, 되돌릴 수 없습니다.`
    );
    if (!ok) return;

    const deletions: MealUpdate[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      for (const diet of DIET_TYPES) {
        for (const mealType of MEAL_TYPES) {
          for (const category of CATEGORIES) {
            const key = buildKey(d, diet, mealType, category);
            if (data[key]) {
              deletions.push({ key, date: d, diet, mealType, category, value: "" });
            }
          }
        }
      }
    }

    if (deletions.length === 0) {
      alert("이번 주에 등록된 내용이 없습니다.");
      return;
    }

    setData((prev) => {
      const next = { ...prev };
      for (const u of deletions) next[u.key] = "";
      return next;
    });

    await commitMealUpdates(deletions);
    alert(`이번 주 식단 ${deletions.length}건을 삭제했습니다.`);
  }

  // 지금 선택된 날짜 하루치 - 모든 식단 종류 - 삭제
  async function handleDeleteDay() {
    setShowDeleteMenu(false);
    const label = formatDate(selectedDate);
    const ok = window.confirm(
      `${label} 하루치 식단(모든 식단 종류)을 삭제할까요?\n되돌릴 수 없습니다.`
    );
    if (!ok) return;

    const deletions: MealUpdate[] = [];
    for (const diet of DIET_TYPES) {
      for (const mealType of MEAL_TYPES) {
        for (const category of CATEGORIES) {
          const key = buildKey(selectedDate, diet, mealType, category);
          if (data[key]) {
            deletions.push({ key, date: selectedDate, diet, mealType, category, value: "" });
          }
        }
      }
    }

    if (deletions.length === 0) {
      alert("선택한 날짜에 등록된 내용이 없습니다.");
      return;
    }

    setData((prev) => {
      const next = { ...prev };
      for (const u of deletions) next[u.key] = "";
      return next;
    });

    await commitMealUpdates(deletions);
    alert(`${label} 식단 ${deletions.length}건을 삭제했습니다.`);
  }

  // 지금까지 등록된 모든 날짜 전체 삭제 (서버에서 컬렉션 자체를 비움)
  async function handleDeleteAll() {
    setShowDeleteMenu(false);
    const typed = window.prompt(
      '정말로 전체 식단 데이터를 삭제합니다. 이번 주뿐 아니라 등록된 모든 날짜가 사라지며 되돌릴 수 없습니다.\n계속하려면 정확히 "삭제"를 입력하세요.'
    );
    if (typed !== "삭제") {
      if (typed !== null) alert("입력값이 일치하지 않아 취소되었습니다.");
      return;
    }

    try {
      const res = await fetch("/api/admin/meals/delete-all", { method: "POST" });
      const json = await res.json();
      if (json.ok) {
        setData({});
        alert(`전체 ${json.deleted}건을 삭제했습니다.`);
      } else {
        alert(json.message ?? "삭제에 실패했습니다.");
      }
    } catch {
      alert("삭제 중 오류가 발생했습니다.");
    }
  }

  // 엑셀 업로드 처리: 헤더 [날짜, 식단, 끼니, 카테고리, 메뉴]
  async function handleExcelUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setExcelBusy(true);
    setExcelResult(null);

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      const errors: string[] = [];
      const updates: Record<string, string> = {};
      const firestoreUpdates: MealUpdate[] = [];
      let success = 0;

      rows.forEach((row, idx) => {
        const rowNum = idx + 2; // 1행은 헤더
        const rawDate = row["날짜"];
        const diet = String(row["식단"] ?? "").trim();
        const mealType = String(row["끼니"] ?? "").trim();
        const category = String(row["카테고리"] ?? "").trim();
        const menu = String(row["메뉴"] ?? "").trim();

        let parsedDate: Date | null = null;
        if (rawDate instanceof Date && !isNaN(rawDate.getTime())) {
          parsedDate = rawDate;
        } else if (typeof rawDate === "string" && rawDate.trim()) {
          const normalized = rawDate.trim().replace(/\./g, "-").replace(/\//g, "-");
          const d = new Date(normalized);
          if (!isNaN(d.getTime())) parsedDate = d;
        } else if (typeof rawDate === "number") {
          // 엑셀 시리얼 날짜값 대비
          const parsed = XLSX.SSF?.parse_date_code?.(rawDate);
          if (parsed) parsedDate = new Date(parsed.y, parsed.m - 1, parsed.d);
        }

        if (!parsedDate) {
          errors.push(`${rowNum}행: 날짜를 인식할 수 없습니다 (${String(rawDate)})`);
          return;
        }
        if (!DIET_TYPES.includes(diet)) {
          errors.push(`${rowNum}행: 식단 종류가 올바르지 않습니다 (${diet || "비어있음"})`);
          return;
        }
        if (!MEAL_TYPES.includes(mealType)) {
          errors.push(`${rowNum}행: 끼니가 올바르지 않습니다 (${mealType || "비어있음"})`);
          return;
        }
        if (!CATEGORIES.includes(category)) {
          errors.push(`${rowNum}행: 카테고리가 올바르지 않습니다 (${category || "비어있음"})`);
          return;
        }
        if (!menu) {
          errors.push(`${rowNum}행: 메뉴명이 비어있습니다`);
          return;
        }

        updates[buildKey(parsedDate, diet, mealType, category)] = menu;
        firestoreUpdates.push({
          key: buildKey(parsedDate, diet, mealType, category),
          date: parsedDate,
          diet,
          mealType,
          category,
          value: menu,
        });
        success++;
      });

      setData((prev) => ({ ...prev, ...updates }));
      if (firestoreUpdates.length > 0) {
        await commitMealUpdates(firestoreUpdates);
      }
      setExcelResult({ success, errors: errors.slice(0, 10) });
    } catch {
      setExcelResult({
        success: 0,
        errors: ["파일을 읽는 중 오류가 발생했습니다. 양식을 확인해주세요."],
      });
    } finally {
      setExcelBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function downloadTemplate() {
    const header = ["날짜", "식단", "끼니", "카테고리", "메뉴"];
    const example = ["2026-07-06", "일반식", "조식", "밥", "현미밥"];
    const ws = XLSX.utils.aoa_to_sheet([header, example]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "식단");
    XLSX.writeFile(wb, "식단표_업로드양식.xlsx");
  }

  // ── 빈칸 일괄 입력 모드 (기존 등록/수정 로직은 건드리지 않고 별도로 얹음) ──
  // 현재 화면(선택된 날짜 x 선택된 식단)에 보이는 24칸만 대상으로 함
  function currentViewKeys() {
    const keys: string[] = [];
    for (const mealType of MEAL_TYPES) {
      for (const category of CATEGORIES) {
        keys.push(cellKey(mealType, category));
      }
    }
    return keys;
  }

  function bulkDirtyCount() {
    return currentViewKeys().filter((key) => (bulkDraft[key] ?? "") !== (data[key] ?? ""))
      .length;
  }

  function enterBulkMode() {
    setEditingKey(null); // 기존 단일 편집 중이던 칸이 있으면 닫기
    setBulkDraft({ ...data });
    setBulkMode(true);
  }

  function exitBulkMode() {
    const dirty = bulkDirtyCount();
    if (dirty > 0) {
      const ok = window.confirm(
        `저장하지 않은 변경사항이 ${dirty}건 있습니다. 저장하지 않고 닫을까요?`
      );
      if (!ok) return;
    }
    setBulkMode(false);
  }

  function updateBulkDraft(key: string, value: string) {
    setBulkDraft((prev) => ({ ...prev, [key]: value }));
  }

  function saveBulkDraft() {
  const updates: MealUpdate[] = [];
  const changedMap: Record<string, string> = {};
  for (const mealType of MEAL_TYPES) {
    for (const category of CATEGORIES) {
      const key = cellKey(mealType, category);
      const nextValue = bulkDraft[key] ?? "";
      if (nextValue !== (data[key] ?? "")) {
        updates.push({ key, date: selectedDate, diet: selectedDiet, mealType, category, value: nextValue });
        changedMap[key] = nextValue;
      }
    }
  }
  setData((prev) => ({ ...prev, ...changedMap })); // 바뀐 24칸 중 실제로 바뀐 것만
  setBulkMode(false);
  if (updates.length > 0) {
    void commitMealUpdates(updates);
  }
}

  function revertBulkDraft() {
    setBulkDraft({ ...data });
  }

  if (!mounted) {
    return (
      <div
        style={{
          maxWidth: 960,
          margin: "40px auto",
          padding: "0 16px 140px",
          width: "100%",
          boxSizing: "border-box",
          textAlign: "center",
          color: "#8a93a3",
        }}
      >
        불러오는 중...
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 960, margin: "40px auto", padding: "0 16px 140px", width: "100%", boxSizing: "border-box" }}>
      <style jsx global>{`
        html, body {
          overflow-x: hidden;
          max-width: 100%;
        }
        *, *::before, *::after {
          box-sizing: border-box;
        }
      `}</style>
      <style jsx>{`
        .diet-tabs-desktop {
          display: flex;
        }
        .diet-tabs-mobile {
          display: none;
        }
        .admin-login-mobile {
          display: none;
        }
        .meal-table-desktop {
          display: block;
        }
        .meal-list-mobile {
          display: none;
        }
        .week-nav {
          gap: 20px;
        }
        .week-nav-label {
          font-size: 16px;
          white-space: nowrap;
        }
        @media (max-width: 640px) {
          .diet-tabs-desktop {
            display: none;
          }
          .diet-tabs-mobile {
            display: flex;
          }
          .admin-login-desktop {
            display: none;
          }
          .admin-login-mobile {
            display: flex;
          }
          .meal-table-desktop {
            display: none;
          }
          .meal-list-mobile {
            display: block;
          }
          .week-nav {
            gap: 8px;
          }
          .week-nav-label {
            font-size: 14px;
          }
        }
        @media (max-width: 360px) {
          .week-nav-label {
            font-size: 12px;
          }
        }
        .site-title-desktop {
          display: block;
        }
        .site-title-mobile {
          display: none;
        }
        @media (max-width: 640px) {
          .site-title-desktop {
            display: none;
          }
          .site-title-mobile {
            display: block;
          }
        }
        .day-tabs-row {
          justify-content: center;
        }
        .day-tab-btn {
          flex: 1 1 0;
          max-width: 120px;
        }
        @media (max-width: 640px) {
          .day-tabs-row {
            justify-content: flex-start;
          }
          .day-tab-btn {
            flex: 0 0 auto;
            max-width: none;
          }
        }
      `}</style>

      {syncError && (
        <div
          style={{
            marginBottom: 16,
            padding: "10px 14px",
            borderRadius: 8,
            background: "#fff5f5",
            border: "1px solid #feb2b2",
            color: "#c53030",
            fontSize: 13,
          }}
        >
          동기화 오류: {syncError} (콘솔에서 [meals] 로그 확인)
        </div>
      )}

      {/* 상단 헤더: 타이틀(좌) + 식단 탭(중앙) + 관리자 설정(우) */}
      <div style={{ position: "relative", marginBottom: 20, minHeight: 44 }}>
        <h1
          className="site-title-desktop"
          style={{ position: "absolute", top: 0, left: 0, ...titleStyle }}
        >
          환자 식단표
        </h1>

        <div
          className="diet-tabs-desktop"
          style={{
            gap: 6,
            justifyContent: "center",
            background: "#f0f2f5",
            borderRadius: 10,
            padding: 4,
            width: "fit-content",
            margin: "0 auto",
          }}
        >
          {DIET_TYPES.map((diet) => {
            const active = diet === selectedDiet;
            return (
              <button
                key={diet}
                onClick={() => setSelectedDiet(diet)}
                style={{
                  border: "none",
                  borderRadius: 8,
                  padding: "8px 18px",
                  fontSize: 14,
                  fontWeight: active ? 600 : 400,
                  cursor: "pointer",
                  background: active ? "#fff" : "transparent",
                  color: active ? "#2b6cb0" : "#4a5568",
                  boxShadow: active ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                }}
              >
                {diet}
              </button>
            );
          })}
        </div>

        <div
          className="admin-login-desktop"
          style={{ position: "absolute", top: 0, right: 0 }}
        >
          <div style={{ position: "relative", display: "inline-block" }}>
            <button
              onClick={() =>
                isAdmin ? setShowAdminMenu((v) => !v) : setShowLogin((v) => !v)
              }
              aria-label="관리자 설정"
              style={gearBtnStyle(isAdmin)}
            >
              <GearIcon active={isAdmin} />
            </button>

            {isAdmin && showAdminMenu && (
              <div style={popoverStyle}>
                <span style={{ fontSize: 13, color: "#2b6cb0", fontWeight: 600 }}>
                  관리자 모드
                </span>
                <button onClick={handleLogout} style={smallBtnStyle}>
                  로그아웃
                </button>
              </div>
            )}

            {!isAdmin && showLogin && (
              <form onSubmit={handleLogin} style={popoverFormStyle}>
                <input
                  type="password"
                  autoFocus
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="관리자 비밀번호"
                  style={{
                    padding: "6px 10px",
                    border: "1px solid #d7dbe3",
                    borderRadius: 6,
                    fontSize: 13,
                    width: "100%",
                    boxSizing: "border-box",
                  }}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="submit" disabled={loading} style={smallBtnStyle}>
                    {loading ? "확인 중..." : "확인"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowLogin(false);
                      setLoginError("");
                      setPasswordInput("");
                    }}
                    style={smallBtnStyle}
                  >
                    취소
                  </button>
                </div>
                {loginError && (
                  <span style={{ fontSize: 12, color: "#e53e3e" }}>{loginError}</span>
                )}
              </form>
            )}
          </div>
        </div>
      </div>

      {/* 식단 종류 탭 - 모바일: 하단 고정 탭바 */}
      <div
        className="diet-tabs-mobile"
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          background: "#fff",
          borderTop: "1px solid #e2e5ea",
          justifyContent: "space-around",
          alignItems: "center",
          gap: 6,
          padding: "10px 8px calc(10px + env(safe-area-inset-bottom))",
          zIndex: 50,
        }}
      >
        {DIET_TYPES.map((diet) => {
          const active = diet === selectedDiet;
          return (
            <button
              key={diet}
              onClick={() => setSelectedDiet(diet)}
              style={{
                border: "none",
                cursor: "pointer",
                fontSize: 14,
                fontWeight: active ? 700 : 500,
                color: active ? "#fff" : "#5a6472",
                background: active ? "#2b6cb0" : "transparent",
                borderRadius: 12,
                minHeight: 56,
                padding: "8px 4px",
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "background 0.15s ease, color 0.15s ease",
              }}
            >
              {diet}
            </button>
          );
        })}
      </div>

      {/* 타이틀 + 관리자 설정 - 모바일 전용 */}
      <div
        className="admin-login-mobile"
        style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}
      >
        <h1 className="site-title-mobile" style={titleStyleMobile}>
          환자 식단표
        </h1>

        <div style={{ position: "relative", display: "inline-block" }}>
          <button
            onClick={() =>
              isAdmin ? setShowAdminMenu((v) => !v) : setShowLogin((v) => !v)
            }
            aria-label="관리자 설정"
            style={gearBtnStyle(isAdmin)}
          >
            <GearIcon active={isAdmin} />
          </button>

          {isAdmin && showAdminMenu && (
            <div style={popoverStyle}>
              <span style={{ fontSize: 13, color: "#2b6cb0", fontWeight: 600 }}>
                관리자 모드
              </span>
              <button onClick={handleLogout} style={smallBtnStyle}>
                로그아웃
              </button>
            </div>
          )}

          {!isAdmin && showLogin && (
            <form onSubmit={handleLogin} style={popoverFormStyle}>
              <input
                type="password"
                autoFocus
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="관리자 비밀번호"
                style={{
                  padding: "6px 10px",
                  border: "1px solid #d7dbe3",
                  borderRadius: 6,
                  fontSize: 13,
                  width: "100%",
                  boxSizing: "border-box",
                }}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button type="submit" disabled={loading} style={smallBtnStyle}>
                  {loading ? "확인 중..." : "확인"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowLogin(false);
                    setLoginError("");
                    setPasswordInput("");
                  }}
                  style={smallBtnStyle}
                >
                  취소
                </button>
              </div>
              {loginError && (
                <span style={{ fontSize: 12, color: "#e53e3e" }}>{loginError}</span>
              )}
            </form>
          )}
        </div>
      </div>

      {/* 주간 네비게이션 */}
      <div
        className="week-nav"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 24,
          maxWidth: "100%",
        }}
      >
        <button onClick={goPrevWeek} aria-label="이전 주" style={{ ...navBtnStyle, flexShrink: 0 }}>
          ◀
        </button>
        <button onClick={goToday} className="week-nav-label" style={{ ...dateBtnStyle, fontSize: undefined }}>
          {formatDate(weekStart)} ~ {formatDate(weekEnd)}
        </button>
        <button onClick={goNextWeek} aria-label="다음 주" style={{ ...navBtnStyle, flexShrink: 0 }}>
          ▶
        </button>
      </div>

      {/* 관리자 전용 툴바: 주간 복사 / 엑셀 업로드 */}
      {isAdmin && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            justifyContent: "center",
            marginBottom: 16,
          }}
        >
          <button onClick={handleCopyWeek} style={toolbarBtnStyle}>
            이번 주 → 다음 주 복사
          </button>

          <button onClick={downloadTemplate} style={toolbarBtnStyle}>
            엑셀 양식 다운로드
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            style={toolbarBtnStyle}
            disabled={excelBusy}
          >
            {excelBusy ? "업로드 중..." : "엑셀로 일괄 등록"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleExcelUpload}
            style={{ display: "none" }}
          />
          {!bulkMode ? (
            <button onClick={enterBulkMode} style={toolbarBtnStyle}>
              빈칸 일괄 입력
            </button>
          ) : (
            <>
              <span style={{ fontSize: 13, color: "#2b6cb0", alignSelf: "center" }}>
                {bulkDirtyCount() > 0 ? `${bulkDirtyCount()}개 항목 변경됨` : "변경 없음"}
              </span>
              <button onClick={revertBulkDraft} style={toolbarBtnStyle}>
                되돌리기
              </button>
              <button
                onClick={saveBulkDraft}
                style={{
                  ...toolbarBtnStyle,
                  background: "#2b6cb0",
                  color: "#fff",
                  border: "1px solid #2b6cb0",
                }}
              >
                저장
              </button>
              <button onClick={exitBulkMode} style={toolbarBtnStyle}>
                닫기
              </button>
            </>
          )}

          <div style={{ position: "relative", display: "inline-block", marginLeft: "auto" }}>
            <button onClick={() => setShowDeleteMenu((v) => !v)} style={dangerBtnStyle}>
              삭제
            </button>
            {showDeleteMenu && (
              <div style={{ ...deleteMenuStyle, left: "auto", right: 0 }}>
                <button onClick={handleDeleteDay} style={deleteMenuItemStyle}>
                  선택한 날짜만 삭제
                </button>
                <button onClick={handleDeleteWeek} style={deleteMenuItemStyle}>
                  이번 주 전체 삭제
                </button>
                <button
                  onClick={handleDeleteAll}
                  style={{ ...deleteMenuItemStyle, color: "#e53e3e", fontWeight: 600 }}
                >
                  전체 삭제
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {excelResult && (
        <div
          style={{
            ...resultBoxStyle,
            borderColor: excelResult.errors.length > 0 ? "#e53e3e" : "#2b6cb0",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: excelResult.errors.length ? 6 : 0 }}>
            엑셀 업로드 결과: 성공 {excelResult.success}건
            {excelResult.errors.length > 0 &&
              ` · 오류 ${excelResult.errors.length}건${
                excelResult.errors.length >= 10 ? "+" : ""
              }`}
          </div>
          {excelResult.errors.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#e53e3e" }}>
              {excelResult.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          )}
          <button
            onClick={() => setExcelResult(null)}
            style={{ ...smallBtnStyle, marginTop: 8 }}
          >
            닫기
          </button>
        </div>
      )}

      {/* 요일 탭 */}
      <div
        className="day-tabs-row"
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 20,
          overflowX: "auto",
          paddingBottom: 4,
          WebkitOverflowScrolling: "touch",
        }}
      >
        {days.map((d, i) => {
          const active = isSameDay(d, selectedDate);
          const isToday = isSameDay(d, today);
          return (
            <button
              key={i}
              className="day-tab-btn"
              onClick={() => setSelectedDate(d)}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: active ? "2px solid #2b6cb0" : "1px solid #e2e5ea",
                background: active ? "#ebf4ff" : "#fff",
                cursor: "pointer",
                minWidth: 56,
                flexShrink: 0,
                textAlign: "center",
                position: "relative",
              }}
            >
              <div style={{ fontSize: 12, color: "#8a93a3", marginBottom: 2 }}>
                {DAY_LABELS[i]}
              </div>
              <div style={{ fontWeight: active ? 700 : 500 }}>{d.getDate()}</div>
              {isToday && (
                <div
                  style={{
                    position: "absolute",
                    bottom: 4,
                    left: "50%",
                    transform: "translateX(-50%)",
                    width: 4,
                    height: 4,
                    borderRadius: 2,
                    background: "#2b6cb0",
                  }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* 표 - PC 전용 */}
      <div className="meal-table-desktop" style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
      <table style={{ width: "100%", minWidth: 560, borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr>
            <th style={thStyle}></th>
            {CATEGORIES.map((c) => (
              <th key={c} style={thStyle}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MEAL_TYPES.map((mealType) => (
            <tr key={mealType}>
              <td style={{ ...tdStyle, fontWeight: 600, background: "#f7f8fa" }}>
                {mealType}
              </td>
              {CATEGORIES.map((category, catIdx) => {
                const key = cellKey(mealType, category);

                // 빈칸 일괄 입력 모드: 기존 등록/수정 로직과 완전히 분리된 별도 렌더링
                if (bulkMode) {
                  const mealIdx = MEAL_TYPES.indexOf(mealType);
                  const tabOrder = mealIdx * CATEGORIES.length + catIdx + 1;
                  const draftValue = bulkDraft[key] ?? "";
                  const isEmpty = draftValue.trim() === "";
                  return (
                    <td key={category} style={tdStyle}>
                      <input
                        tabIndex={tabOrder}
                        value={draftValue}
                        placeholder="입력"
                        onChange={(e) => updateBulkDraft(key, e.target.value)}
                        style={{
                          width: "100%",
                          padding: "6px 8px",
                          border: isEmpty ? "1px solid #2b6cb0" : "1px solid #d7dbe3",
                          borderRadius: 6,
                          fontSize: 13,
                          boxSizing: "border-box",
                        }}
                      />
                    </td>
                  );
                }

                // 기존 등록/수정 로직 — 변경 없음
                const value = data[key];
                const isEditing = editingKey === key;
                return (
                  <td key={category} style={tdStyle}>
                    {isEditing ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => {
                          saveEdit(key);
                          void persistMealDoc(key, selectedDate, selectedDiet, mealType, category, draft);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            saveEdit(key);
                            void persistMealDoc(key, selectedDate, selectedDiet, mealType, category, draft);
                          }
                          if (e.key === "Escape") setEditingKey(null);
                        }}
                        style={{
                          width: "100%",
                          padding: "6px 8px",
                          border: "1px solid #2b6cb0",
                          borderRadius: 6,
                          fontSize: 13,
                          boxSizing: "border-box",
                        }}
                      />
                    ) : value ? (
                      isAdmin ? (
                        <button
                          onClick={() => startEdit(mealType, category)}
                          style={valueBtnStyle}
                        >
                          {value}
                        </button>
                      ) : (
                        <span style={valueTextStyle}>{value}</span>
                      )
                    ) : isAdmin ? (
                      <button
                        onClick={() => startEdit(mealType, category)}
                        style={registerBtnStyle}
                      >
                        등록
                      </button>
                    ) : (
                      <span style={emptyTextStyle}>-</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {/* 식단표 - 모바일 전용 세로 카드 리스트 */}
      <div className="meal-list-mobile">
        {MEAL_TYPES.map((mealType) => (
          <div key={mealType} style={{ marginBottom: 18 }}>
            <div style={{ fontWeight: 600, fontSize: 15, color: "#1f2430", marginBottom: 8 }}>
              {mealType}
            </div>
            <div
              style={{
                border: "1px solid #e2e5ea",
                borderRadius: 10,
                overflow: "hidden",
                background: "#fff",
              }}
            >
              {CATEGORIES.map((category, idx) => {
                const key = cellKey(mealType, category);
                const value = data[key];
                const isEditing = editingKey === key;
                return (
                  <div
                    key={category}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: "10px 12px",
                      borderTop: idx === 0 ? "none" : "1px solid #f0f2f5",
                    }}
                  >
                    <span style={{ fontSize: 13, color: "#8a93a3", flexShrink: 0, minWidth: 56 }}>
                      {category}
                    </span>
                    <div style={{ flex: 1, textAlign: "right" }}>
                      {isEditing ? (
                        <input
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={() => {
                            saveEdit(key);
                            void persistMealDoc(key, selectedDate, selectedDiet, mealType, category, draft);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              saveEdit(key);
                              void persistMealDoc(key, selectedDate, selectedDiet, mealType, category, draft);
                            }
                            if (e.key === "Escape") setEditingKey(null);
                          }}
                          style={{
                            width: "100%",
                            padding: "6px 8px",
                            border: "1px solid #2b6cb0",
                            borderRadius: 6,
                            fontSize: 13,
                            boxSizing: "border-box",
                            textAlign: "right",
                          }}
                        />
                      ) : value ? (
                        isAdmin ? (
                          <button
                            onClick={() => startEdit(mealType, category)}
                            style={{ ...valueBtnStyle, width: "auto" }}
                          >
                            {value}
                          </button>
                        ) : (
                          <span style={valueTextStyle}>{value}</span>
                        )
                      ) : isAdmin ? (
                        <button
                          onClick={() => startEdit(mealType, category)}
                          style={registerBtnStyle}
                        >
                          등록
                        </button>
                      ) : (
                        <span style={emptyTextStyle}>-</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GearIcon({ active }: { active?: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke={active ? "#2b6cb0" : "#4a5568"}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function gearBtnStyle(active: boolean): CSSProperties {
  return {
    width: 36,
    height: 36,
    borderRadius: "50%",
    border: active ? "1px solid #2b6cb0" : "1px solid #e2e5ea",
    background: active ? "#ebf4ff" : "#fff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };
}

const titleStyle: CSSProperties = {
  fontSize: 26,
  fontWeight: 800,
  color: "#1f2430",
  margin: 0,
  letterSpacing: "-0.02em",
};

const titleStyleMobile: CSSProperties = {
  fontSize: 20,
  fontWeight: 800,
  color: "#1f2430",
  margin: 0,
  letterSpacing: "-0.02em",
};

const popoverStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 8px)",
  right: 0,
  background: "#fff",
  border: "1px solid #e2e5ea",
  borderRadius: 10,
  padding: "10px 12px",
  boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
  display: "flex",
  alignItems: "center",
  gap: 10,
  whiteSpace: "nowrap",
  zIndex: 30,
};

const popoverFormStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 8px)",
  right: 0,
  background: "#fff",
  border: "1px solid #e2e5ea",
  borderRadius: 10,
  padding: 12,
  boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  minWidth: 200,
  zIndex: 30,
};

const toolbarBtnStyle: CSSProperties = {
  border: "1px solid #d7dbe3",
  background: "#fff",
  borderRadius: 8,
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: 13,
  color: "#1f2430",
  fontWeight: 500,
};

const dangerBtnStyle: CSSProperties = {
  border: "1px solid #e53e3e",
  background: "#fff",
  borderRadius: 8,
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: 13,
  color: "#e53e3e",
  fontWeight: 600,
};

const deleteMenuStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  left: 0,
  background: "#fff",
  border: "1px solid #e2e5ea",
  borderRadius: 10,
  boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
  padding: 6,
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 160,
  zIndex: 30,
};

const deleteMenuItemStyle: CSSProperties = {
  border: "none",
  background: "transparent",
  textAlign: "left",
  padding: "8px 10px",
  borderRadius: 6,
  fontSize: 13,
  cursor: "pointer",
  color: "#1f2430",
};

const resultBoxStyle: CSSProperties = {
  border: "1px solid #e2e5ea",
  borderRadius: 10,
  padding: 12,
  marginBottom: 16,
  background: "#f9fafb",
  fontSize: 13,
};

const navBtnStyle: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: "50%",
  border: "1px solid #e2e5ea",
  background: "#fff",
  cursor: "pointer",
  fontSize: 18,
  lineHeight: 1,
  color: "#4a5568",
};

const dateBtnStyle: CSSProperties = {
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: 16,
  fontWeight: 600,
  color: "#1f2430",
};

const smallBtnStyle: CSSProperties = {
  border: "1px solid #d7dbe3",
  background: "#fff",
  borderRadius: 6,
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: 13,
  color: "#4a5568",
};

const thStyle: CSSProperties = {
  border: "1px solid #e2e5ea",
  padding: "10px 8px",
  background: "#f0f2f5",
  fontWeight: 600,
};

const tdStyle: CSSProperties = {
  border: "1px solid #e2e5ea",
  padding: "8px",
  textAlign: "center",
};

const valueBtnStyle: CSSProperties = {
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: 13,
  color: "#1f2430",
  width: "100%",
};

const valueTextStyle: CSSProperties = {
  fontSize: 13,
  color: "#1f2430",
};

const registerBtnStyle: CSSProperties = {
  border: "1px dashed #c3cad6",
  background: "transparent",
  cursor: "pointer",
  fontSize: 12,
  color: "#8a93a3",
  borderRadius: 6,
  padding: "4px 10px",
};

const emptyTextStyle: CSSProperties = {
  fontSize: 13,
  color: "#c3cad6",
};
