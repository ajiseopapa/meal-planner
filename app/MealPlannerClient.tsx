"use client";

import {
  useState,
  useEffect,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import * as XLSX from "xlsx";
import { db } from "@/lib/firebase";
import { collection, onSnapshot, query, where } from "firebase/firestore";

const MEAL_TYPES = ["조식", "중식", "석식", "간식"];
const CATEGORIES = ["밥", "국", "반찬A", "반찬B", "반찬C", "반찬D"];
const DAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"];
const DIET_TYPES = ["일반식", "CA식", "당뇨식", "항암식"];

// 컴포넌트 바깥의 일반 함수(commitMealUpdates 등)에서도 예쁜 알림 모달을 띄울 수 있도록,
// 컴포넌트가 마운트되는 동안 알림 함수를 등록해두는 아주 작은 저장소입니다.
type NoticeVariant = "success" | "error" | "info";
let globalNotify: ((message: string, variant?: NoticeVariant) => void) | null = null;
function notify(message: string, variant: NoticeVariant = "info") {
  if (globalNotify) {
    globalNotify(message, variant);
  } else {
    window.alert(message);
  }
}

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

// ── 영양 정보 + 알레르기 유발 성분 ──
// Firestore의 "value" 필드는 그대로 문자열이지만, 영양 정보/알레르기 정보가 있는 칸은
// 그 문자열 안에 JSON을 담아 저장합니다:
// {"n":"메뉴명","kcal":320,"protein":8,"sodium":450,"aller":["egg","milk"]}
// 아무 정보도 없는 칸(과거 데이터 포함)은 그냥 일반 텍스트 메뉴명 그대로 둡니다.
type Nutrition = { kcal?: number; protein?: number; sodium?: number };
type ParsedMeal = { name: string; nutrition: Nutrition; allergens: string[] };

// 식품위생법상 표시 대상 알레르기 유발 성분 (식약처 고시 기준, 19개 항목)
const ALLERGENS: { id: string; label: string; icon: string }[] = [
  { id: "egg", label: "계란", icon: "🥚" },
  { id: "milk", label: "우유", icon: "🥛" },
  { id: "buckwheat", label: "메밀", icon: "🌾" },
  { id: "peanut", label: "땅콩", icon: "🥜" },
  { id: "soy", label: "대두", icon: "🫘" },
  { id: "wheat", label: "밀", icon: "🍞" },
  { id: "mackerel", label: "고등어", icon: "🐟" },
  { id: "crab", label: "게", icon: "🦀" },
  { id: "shrimp", label: "새우", icon: "🦐" },
  { id: "pork", label: "돼지고기", icon: "🐷" },
  { id: "peach", label: "복숭아", icon: "🍑" },
  { id: "tomato", label: "토마토", icon: "🍅" },
  { id: "sulfite", label: "아황산류", icon: "🧪" },
  { id: "walnut", label: "호두", icon: "🌰" },
  { id: "chicken", label: "닭고기", icon: "🐔" },
  { id: "beef", label: "쇠고기", icon: "🐮" },
  { id: "squid", label: "오징어", icon: "🦑" },
  { id: "shellfish", label: "조개류", icon: "🐚" },
  { id: "pinenut", label: "잣", icon: "🌲" },
];

function getAllergenMeta(id: string) {
  return ALLERGENS.find((a) => a.id === id) ?? { id, label: id, icon: "⚠️" };
}

function parseMealValue(raw?: string): ParsedMeal {
  if (!raw) return { name: "", nutrition: {}, allergens: [] };
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && typeof obj.n === "string") {
        return {
          name: obj.n,
          nutrition: {
            kcal: typeof obj.kcal === "number" ? obj.kcal : undefined,
            protein: typeof obj.protein === "number" ? obj.protein : undefined,
            sodium: typeof obj.sodium === "number" ? obj.sodium : undefined,
          },
          allergens: Array.isArray(obj.aller)
            ? obj.aller.filter((x: unknown): x is string => typeof x === "string")
            : [],
        };
      }
    } catch {
      // JSON 파싱에 실패하면 그냥 평범한 텍스트로 취급합니다.
    }
  }
  return { name: raw, nutrition: {}, allergens: [] };
}

function serializeMealValue(name: string, nutrition: Nutrition, allergens: string[] = []): string {
  const trimmedName = name.trim();
  const hasNutrition =
    nutrition.kcal !== undefined ||
    nutrition.protein !== undefined ||
    nutrition.sodium !== undefined;
  const hasAllergens = allergens.length > 0;
  if (!hasNutrition && !hasAllergens) return trimmedName;
  const payload: Record<string, unknown> = { n: trimmedName };
  if (nutrition.kcal !== undefined) payload.kcal = nutrition.kcal;
  if (nutrition.protein !== undefined) payload.protein = nutrition.protein;
  if (nutrition.sodium !== undefined) payload.sodium = nutrition.sodium;
  if (hasAllergens) payload.aller = allergens;
  return JSON.stringify(payload);
}

function formatNutritionLine(nutrition: Nutrition): string {
  const parts: string[] = [];
  if (nutrition.kcal !== undefined) parts.push(`${nutrition.kcal}kcal`);
  if (nutrition.protein !== undefined) parts.push(`단백질 ${nutrition.protein}g`);
  if (nutrition.sodium !== undefined) parts.push(`나트륨 ${nutrition.sodium}mg`);
  return parts.join(" · ");
}

type MealUpdate = {
  key: string;
  date: Date;
  diet: string;
  mealType: string;
  category: string;
  value: string;
};

// ── 선호도(좋아요/별로예요) + 잔반 체크 ──
// 서버 집계는 Firestore의 "feedback" 컬렉션(문서 1개 = meals와 동일한 key)에 누적 카운트로 저장됩니다.
// 브라우저는 "이 기기에서 이미 무엇을 눌렀는지"만 localStorage에 기억해서 중복 집계를 막습니다.
type FeedbackCounts = { good?: number; bad?: number; leftover?: number; comments?: string[] };
type UserFeedbackState = { rating?: "good" | "bad"; leftover?: boolean };
const FEEDBACK_STORAGE_KEY = "mealPlanner.myFeedback.v1";

async function sendFeedback(input: {
  key: string;
  date: Date;
  diet: string;
  mealType: string;
  category: string;
  kind: "good" | "bad" | "leftover";
  delta: 1 | -1;
  comment?: string;
}) {
  try {
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: input.key,
        date: toISODate(input.date),
        diet: input.diet,
        mealType: input.mealType,
        category: input.category,
        kind: input.kind,
        delta: input.delta,
        comment: input.comment,
      }),
    });
  } catch (err) {
    console.error("[feedback] 전송 실패", err);
  }
}

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
    notify("식단 저장에 실패했습니다. 다시 시도해주세요.", "error");
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
  // 편집 중인 칸의 영양 정보 초안 (문자열 입력값 그대로 보관, 저장 시 숫자로 변환)
  const [nutritionDraft, setNutritionDraft] = useState<{
    kcal: string;
    protein: string;
    sodium: string;
  }>({ kcal: "", protein: "", sodium: "" });
  const [allergenDraft, setAllergenDraft] = useState<string[]>([]);

  // 로그인 관련 상태
  const [showLogin, setShowLogin] = useState(false);
  const [showAdminMenu, setShowAdminMenu] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loading, setLoading] = useState(false);

  // 삭제 메뉴(하루/이번주/전체) 열림 상태
  const [showDeleteMenu, setShowDeleteMenu] = useState(false);
  const [deleteModal, setDeleteModal] = useState<null | "day" | "week" | "all">(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);

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

  // 선호도/잔반 피드백: 서버 집계(feedbackMap)와 "이 기기에서 내가 누른 것"(userFeedback)
  const [feedbackMap, setFeedbackMap] = useState<Record<string, FeedbackCounts>>({});
  const [userFeedback, setUserFeedback] = useState<Record<string, UserFeedbackState>>({});
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(FEEDBACK_STORAGE_KEY);
      if (raw) setUserFeedback(JSON.parse(raw));
    } catch {
      // localStorage를 못 읽어도(시크릿 모드 등) 기능이 죽지 않도록 조용히 무시합니다.
    }
  }, []);

  // 예쁜 알림 모달 상태 + 컴포넌트 바깥 함수도 쓸 수 있도록 전역 등록
  const [notice, setNotice] = useState<{ message: string; variant: NoticeVariant } | null>(null);
  useEffect(() => {
    globalNotify = (message, variant = "info") => setNotice({ message, variant });
    return () => {
      globalNotify = null;
    };
  }, []);
  // 알림 모달도 Esc 키로 닫을 수 있게 합니다.
  useEffect(() => {
    if (!notice) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setNotice(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [notice]);

  // 삭제 확인 모달이 열려 있을 때 Esc 키로 닫을 수 있게 합니다.
  useEffect(() => {
    if (!deleteModal) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeDeleteModal();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteModal, deleteLoading]);

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

  // Firestore 실시간 구독: 선호도/잔반 집계(feedback 컬렉션) — 식단 구독과 동일한 주간 범위
  useEffect(() => {
    const startISO = toISODate(weekStart);
    const weekEndForQuery = new Date(weekStart);
    weekEndForQuery.setDate(weekStart.getDate() + 6);
    const endISO = toISODate(weekEndForQuery);

    const q = query(
      collection(db, "feedback"),
      where("date", ">=", startISO),
      where("date", "<=", endISO)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const map: Record<string, FeedbackCounts> = {};
        snapshot.forEach((docSnap) => {
          const d = docSnap.data();
          map[docSnap.id] = {
            good: typeof d.good === "number" ? d.good : undefined,
            bad: typeof d.bad === "number" ? d.bad : undefined,
            leftover: typeof d.leftover === "number" ? d.leftover : undefined,
            comments: Array.isArray(d.comments) ? d.comments : undefined,
          };
        });
        setFeedbackMap(map);
      },
      (err) => {
        console.error("[feedback] 구독 에러:", err.code, err.message, err);
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

  function persistUserFeedback(next: Record<string, UserFeedbackState>) {
    setUserFeedback(next);
    try {
      window.localStorage.setItem(FEEDBACK_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 저장 실패해도 화면 상태는 이미 반영됐으니 무시합니다.
    }
  }

  // 좋아요/별로예요는 서로 배타적인 단일 선택입니다. 같은 걸 다시 누르면 선택을 취소합니다.
  function toggleRating(
    key: string,
    mealType: string,
    category: string,
    rating: "good" | "bad"
  ) {
    const current = userFeedback[key]?.rating;
    if (current === rating) {
      void sendFeedback({ key, date: selectedDate, diet: selectedDiet, mealType, category, kind: rating, delta: -1 });
      persistUserFeedback({ ...userFeedback, [key]: { ...userFeedback[key], rating: undefined } });
      return;
    }
    let comment: string | undefined;
    if (rating === "bad" && typeof window !== "undefined") {
      comment = window.prompt("어떤 점이 별로였는지 간단히 남겨주시겠어요? (선택 사항)") ?? undefined;
    }
    if (current) {
      void sendFeedback({ key, date: selectedDate, diet: selectedDiet, mealType, category, kind: current, delta: -1 });
    }
    void sendFeedback({ key, date: selectedDate, diet: selectedDiet, mealType, category, kind: rating, delta: 1, comment });
    persistUserFeedback({ ...userFeedback, [key]: { ...userFeedback[key], rating } });
  }

  // 잔반 체크는 좋아요/별로예요와 독립적인 토글입니다.
  function toggleLeftover(key: string, mealType: string, category: string) {
    const wasChecked = !!userFeedback[key]?.leftover;
    void sendFeedback({
      key,
      date: selectedDate,
      diet: selectedDiet,
      mealType,
      category,
      kind: "leftover",
      delta: wasChecked ? -1 : 1,
    });
    persistUserFeedback({ ...userFeedback, [key]: { ...userFeedback[key], leftover: !wasChecked } });
  }

  function startEdit(mealType: string, category: string) {
    if (!isAdmin) return;
    const key = cellKey(mealType, category);
    const parsed = parseMealValue(data[key]);
    setEditingKey(key);
    setDraft(parsed.name);
    setNutritionDraft({
      kcal: parsed.nutrition.kcal !== undefined ? String(parsed.nutrition.kcal) : "",
      protein: parsed.nutrition.protein !== undefined ? String(parsed.nutrition.protein) : "",
      sodium: parsed.nutrition.sodium !== undefined ? String(parsed.nutrition.sodium) : "",
    });
    setAllergenDraft(parsed.allergens);
  }

  // 현재 draft(메뉴명) + nutritionDraft(칼로리/단백질/나트륨) + allergenDraft(알레르기)를
  // 하나의 저장용 문자열로 합칩니다.
  function buildSerializedDraft(): string {
    const nutrition: Nutrition = {};
    const kcalNum = Number(nutritionDraft.kcal);
    if (nutritionDraft.kcal.trim() !== "" && !Number.isNaN(kcalNum)) nutrition.kcal = kcalNum;
    const proteinNum = Number(nutritionDraft.protein);
    if (nutritionDraft.protein.trim() !== "" && !Number.isNaN(proteinNum))
      nutrition.protein = proteinNum;
    const sodiumNum = Number(nutritionDraft.sodium);
    if (nutritionDraft.sodium.trim() !== "" && !Number.isNaN(sodiumNum))
      nutrition.sodium = sodiumNum;
    return serializeMealValue(draft, nutrition, allergenDraft);
  }

  // 한 칸의 편집을 확정(저장)합니다: 로컬 상태 반영 + 서버에 저장 + 편집 모드 종료
  function commitCellEdit(key: string, mealType: string, category: string) {
    const serialized = buildSerializedDraft();
    setData((prev) => ({ ...prev, [key]: serialized }));
    setEditingKey(null);
    void persistMealDoc(key, selectedDate, selectedDiet, mealType, category, serialized);
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

  // 삭제 확인 모달을 닫습니다 (삭제 진행 중에는 닫지 않음).
  function closeDeleteModal() {
    if (deleteLoading) return;
    setDeleteModal(null);
    setDeleteConfirmText("");
  }

  // 삭제 메뉴의 각 항목은 실제 삭제를 바로 실행하지 않고, 예쁜 확인 모달을 엽니다.
  function handleDeleteDay() {
    setShowDeleteMenu(false);
    setDeleteModal("day");
  }

  function handleDeleteWeek() {
    setShowDeleteMenu(false);
    setDeleteModal("week");
  }

  function handleDeleteAll() {
    setShowDeleteMenu(false);
    setDeleteConfirmText("");
    setDeleteModal("all");
  }

  // 지금 선택된 날짜 하루치 - 모든 식단 종류 - 삭제
  async function executeDeleteDay() {
    const label = formatDate(selectedDate);
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
      setDeleteModal(null);
      notify("선택한 날짜에 등록된 내용이 없습니다.", "info");
      return;
    }

    setDeleteLoading(true);
    setData((prev) => {
      const next = { ...prev };
      for (const u of deletions) next[u.key] = "";
      return next;
    });

    await commitMealUpdates(deletions);
    setDeleteLoading(false);
    setDeleteModal(null);
    notify(`${label} 식단 ${deletions.length}건을 삭제했습니다.`, "success");
  }

  // 이번 주(월~일) 전체 - 모든 식단 종류 x 끼니 x 카테고리 - 를 통째로 삭제
  async function executeDeleteWeek() {
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
      setDeleteModal(null);
      notify("이번 주에 등록된 내용이 없습니다.", "info");
      return;
    }

    setDeleteLoading(true);
    setData((prev) => {
      const next = { ...prev };
      for (const u of deletions) next[u.key] = "";
      return next;
    });

    await commitMealUpdates(deletions);
    setDeleteLoading(false);
    setDeleteModal(null);
    notify(`이번 주 식단 ${deletions.length}건을 삭제했습니다.`, "success");
  }

  // 지금까지 등록된 모든 날짜 전체 삭제 (서버에서 컬렉션 자체를 비움)
  async function executeDeleteAll() {
    if (deleteConfirmText !== "삭제") return;

    setDeleteLoading(true);
    try {
      const res = await fetch("/api/admin/meals/delete-all", { method: "POST" });
      const json = await res.json();
      if (json.ok) {
        setData({});
        setDeleteModal(null);
        notify(`전체 ${json.deleted}건을 삭제했습니다.`, "success");
      } else {
        notify(json.message ?? "삭제에 실패했습니다.", "error");
      }
    } catch {
      notify("삭제 중 오류가 발생했습니다.", "error");
    } finally {
      setDeleteLoading(false);
      setDeleteConfirmText("");
    }
  }

  // 삭제 확인 모달에 표시할 제목/설명/버튼 텍스트를 종류별로 반환합니다.
  function getDeleteModalContent(): {
    title: string;
    message: string;
    confirmLabel: string;
    requireTyped: boolean;
    onConfirm: () => void;
  } | null {
    if (deleteModal === "day") {
      return {
        title: "선택한 날짜 삭제",
        message: `${formatDate(
          selectedDate
        )} 하루치 식단(모든 식단 종류)을 삭제할까요?\n되돌릴 수 없습니다.`,
        confirmLabel: "삭제",
        requireTyped: false,
        onConfirm: () => void executeDeleteDay(),
      };
    }
    if (deleteModal === "week") {
      return {
        title: "이번 주 전체 삭제",
        message: `이번 주(${formatDate(weekStart)} ~ ${formatDate(
          weekEnd
        )}) 식단 전체를 삭제할까요?\n모든 식단 종류(일반식/CA식/당뇨식/항암식)의 등록된 내용이 전부 지워지며, 되돌릴 수 없습니다.`,
        confirmLabel: "삭제",
        requireTyped: false,
        onConfirm: () => void executeDeleteWeek(),
      };
    }
    if (deleteModal === "all") {
      return {
        title: "전체 삭제",
        message:
          "정말로 전체 식단 데이터를 삭제합니다.\n이번 주뿐 아니라 등록된 모든 날짜가 사라지며, 되돌릴 수 없습니다.",
        confirmLabel: "완전히 삭제",
        requireTyped: true,
        onConfirm: () => void executeDeleteAll(),
      };
    }
    return null;
  }

  // 지금 보고 있는 주(월~일) 전체 데이터를, 화면에 보이는 표(끼니 x 카테고리) 형태 그대로
  // 요일별 블록으로 이어붙여서 엑셀로 내보내기 (현재 선택된 식단 종류 기준)
  function handleExportExcel() {
    const rows: (string | number)[][] = [];
    const merges: XLSX.Range[] = [];

    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      const dateLabel = `${toISODate(d)} (${DAY_LABELS[i]})`;

      // 날짜 제목 행 (카테고리 열 수만큼 병합)
      const titleRowIndex = rows.length;
      rows.push([dateLabel, ...CATEGORIES.map(() => "")]);
      merges.push({
        s: { r: titleRowIndex, c: 0 },
        e: { r: titleRowIndex, c: CATEGORIES.length },
      });

      // 헤더 행: 빈칸 + 카테고리들
      rows.push(["", ...CATEGORIES]);

      // 끼니별 행
      for (const mealType of MEAL_TYPES) {
        const rowValues = CATEGORIES.map((category) => {
          const key = buildKey(d, selectedDiet, mealType, category);
          const parsed = parseMealValue(data[key]);
          if (!parsed.name) return "";
          const details: string[] = [];
          const nutritionLine = formatNutritionLine(parsed.nutrition);
          if (nutritionLine) details.push(nutritionLine);
          if (parsed.allergens.length > 0) {
            details.push(
              `알레르기: ${parsed.allergens.map((id) => getAllergenMeta(id).label).join(", ")}`
            );
          }
          return details.length > 0 ? `${parsed.name} (${details.join(" / ")})` : parsed.name;
        });
        rows.push([mealType, ...rowValues]);
      }

      // 다음 날짜 블록과 구분하는 빈 줄
      rows.push([]);
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!merges"] = merges;
    ws["!cols"] = [{ wch: 10 }, ...CATEGORIES.map(() => ({ wch: 12 }))];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, selectedDiet);
    const fileName = `식단표_${selectedDiet}_${toISODate(weekStart)}_${toISODate(weekEnd)}.xlsx`;
    XLSX.writeFile(wb, fileName);
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

  // 일괄 입력 모드는 메뉴명(텍스트)만 다룹니다. 영양 정보가 이미 등록되어 있던 칸은
  // 이름만 바뀌어도 기존 영양 정보를 그대로 유지합니다(저장 시 병합).
  function bulkDirtyCount() {
    return currentViewKeys().filter(
      (key) => (bulkDraft[key] ?? "") !== parseMealValue(data[key]).name
    ).length;
  }

  function enterBulkMode() {
    setEditingKey(null); // 기존 단일 편집 중이던 칸이 있으면 닫기
    const names: Record<string, string> = {};
    for (const key of Object.keys(data)) {
      names[key] = parseMealValue(data[key]).name;
    }
    setBulkDraft(names);
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
      const nextName = bulkDraft[key] ?? "";
      const current = parseMealValue(data[key]);
      if (nextName !== current.name) {
        // 이름만 바꾸고, 기존에 등록돼 있던 영양 정보는 그대로 유지해서 합칩니다.
        const nextValue = serializeMealValue(nextName, current.nutrition, current.allergens);
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
    const names: Record<string, string> = {};
    for (const key of Object.keys(data)) {
      names[key] = parseMealValue(data[key]).name;
    }
    setBulkDraft(names);
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
          .header-desktop {
            display: none;
          }
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
        @keyframes deleteModalFadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        @keyframes deleteModalPopIn {
          from {
            opacity: 0;
            transform: translateY(8px) scale(0.96);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        .delete-modal-overlay {
          animation: deleteModalFadeIn 0.15s ease-out;
        }
        .delete-modal-card {
          animation: deleteModalPopIn 0.18s cubic-bezier(0.16, 1, 0.3, 1);
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

      {/* 상단 헤더: 타이틀(좌) + 식단 탭(중앙) + 관리자 설정(우) - 데스크탑 전용 */}
      <div className="header-desktop" style={{ position: "relative", marginBottom: 20, minHeight: 44 }}>
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

          <button onClick={handleExportExcel} style={toolbarBtnStyle}>
            엑셀로 내보내기
          </button>
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

          <div style={{ position: "relative", display: "inline-block" }}>
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

                // 기존 등록/수정 로직 — 메뉴명 + 영양 정보(칼로리/단백질/나트륨) 편집 포함
                const parsedValue = parseMealValue(data[key]);
                const isEditing = editingKey === key;
                return (
                  <td key={category} style={tdStyle}>
                    {isEditing ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <input
                          autoFocus
                          value={draft}
                          placeholder="메뉴명"
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitCellEdit(key, mealType, category);
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
                        <NutritionInputsRow
                          nutritionDraft={nutritionDraft}
                          setNutritionDraft={setNutritionDraft}
                          onEnter={() => commitCellEdit(key, mealType, category)}
                        />
                        <AllergenPickerRow
                          allergenDraft={allergenDraft}
                          setAllergenDraft={setAllergenDraft}
                        />
                        <div style={{ display: "flex", gap: 4 }}>
                          <button
                            onClick={() => commitCellEdit(key, mealType, category)}
                            style={miniSaveBtnStyle}
                          >
                            저장
                          </button>
                          <button
                            onClick={() => setEditingKey(null)}
                            style={miniCancelBtnStyle}
                          >
                            취소
                          </button>
                        </div>
                      </div>
                    ) : parsedValue.name ? (
                      <MealCellDisplay
                        parsed={parsedValue}
                        isAdmin={isAdmin}
                        onClick={() => startEdit(mealType, category)}
                        feedback={feedbackMap[key]}
                        myFeedback={userFeedback[key]}
                        onToggleRating={(rating) => toggleRating(key, mealType, category, rating)}
                        onToggleLeftover={() => toggleLeftover(key, mealType, category)}
                      />
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
                const parsedValue = parseMealValue(data[key]);
                const isEditing = editingKey === key;
                return (
                  <div
                    key={category}
                    style={{
                      display: "flex",
                      alignItems: isEditing ? "flex-start" : "center",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: "10px 12px",
                      borderTop: idx === 0 ? "none" : "1px solid #f0f2f5",
                    }}
                  >
                    <span style={{ fontSize: 13, color: "#8a93a3", flexShrink: 0, minWidth: 56, marginTop: isEditing ? 6 : 0 }}>
                      {category}
                    </span>
                    <div style={{ flex: 1, textAlign: "right" }}>
                      {isEditing ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <input
                            autoFocus
                            value={draft}
                            placeholder="메뉴명"
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitCellEdit(key, mealType, category);
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
                          <NutritionInputsRow
                            nutritionDraft={nutritionDraft}
                            setNutritionDraft={setNutritionDraft}
                            onEnter={() => commitCellEdit(key, mealType, category)}
                          />
                          <AllergenPickerRow
                            allergenDraft={allergenDraft}
                            setAllergenDraft={setAllergenDraft}
                          />
                          <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                            <button
                              onClick={() => commitCellEdit(key, mealType, category)}
                              style={miniSaveBtnStyle}
                            >
                              저장
                            </button>
                            <button
                              onClick={() => setEditingKey(null)}
                              style={miniCancelBtnStyle}
                            >
                              취소
                            </button>
                          </div>
                        </div>
                      ) : parsedValue.name ? (
                        <MealCellDisplay
                          parsed={parsedValue}
                          isAdmin={isAdmin}
                          onClick={() => startEdit(mealType, category)}
                          align="right"
                          feedback={feedbackMap[key]}
                          myFeedback={userFeedback[key]}
                          onToggleRating={(rating) => toggleRating(key, mealType, category, rating)}
                          onToggleLeftover={() => toggleLeftover(key, mealType, category)}
                        />
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

      {deleteModal &&
        (() => {
          const content = getDeleteModalContent();
          if (!content) return null;
          const confirmDisabled =
            deleteLoading || (content.requireTyped && deleteConfirmText !== "삭제");
          return (
            <div className="delete-modal-overlay" style={modalOverlayStyle} onClick={closeDeleteModal}>
              <div
                className="delete-modal-card"
                style={modalCardStyle}
                onClick={(e) => e.stopPropagation()}
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="delete-modal-title"
              >
                <div style={modalIconWrapStyle}>
                  <TrashIcon />
                </div>
                <h3 id="delete-modal-title" style={modalTitleStyle}>
                  {content.title}
                </h3>
                <p style={modalMessageStyle}>{content.message}</p>

                {content.requireTyped && (
                  <div style={{ marginTop: 4 }}>
                    <div style={modalHintStyle}>
                      계속하려면 아래 입력창에 <b style={{ color: "#e53e3e" }}>삭제</b>를
                      입력하세요.
                    </div>
                    <input
                      autoFocus
                      value={deleteConfirmText}
                      onChange={(e) => setDeleteConfirmText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !confirmDisabled) content.onConfirm();
                      }}
                      placeholder="삭제"
                      style={modalInputStyle}
                    />
                  </div>
                )}

                <div style={modalActionsStyle}>
                  <button onClick={closeDeleteModal} style={modalCancelBtnStyle} disabled={deleteLoading}>
                    취소
                  </button>
                  <button
                    onClick={content.onConfirm}
                    disabled={confirmDisabled}
                    style={{
                      ...modalConfirmBtnStyle,
                      opacity: confirmDisabled ? 0.5 : 1,
                      cursor: confirmDisabled ? "not-allowed" : "pointer",
                    }}
                  >
                    {deleteLoading ? "삭제 중..." : content.confirmLabel}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

      {notice && (
        <div
          className="delete-modal-overlay"
          style={modalOverlayStyle}
          onClick={() => setNotice(null)}
        >
          <div
            className="delete-modal-card"
            style={modalCardStyle}
            onClick={(e) => e.stopPropagation()}
            role="alertdialog"
            aria-modal="true"
          >
            <div style={noticeIconWrapStyle(notice.variant)}>
              <NoticeIcon variant={notice.variant} />
            </div>
            <p style={{ ...modalMessageStyle, color: "#1f2430", fontSize: 14.5 }}>
              {notice.message}
            </p>
            <div style={modalActionsStyle}>
              <button
                autoFocus
                onClick={() => setNotice(null)}
                style={noticeOkBtnStyle(notice.variant)}
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 메뉴명 + (있다면) 영양 정보/알레르기 정보를 함께 보여주는 표시용 컴포넌트
function MealCellDisplay({
  parsed,
  isAdmin,
  onClick,
  align = "left",
  feedback,
  myFeedback,
  onToggleRating,
  onToggleLeftover,
}: {
  parsed: ParsedMeal;
  isAdmin: boolean;
  onClick: () => void;
  align?: "left" | "right";
  feedback?: FeedbackCounts;
  myFeedback?: UserFeedbackState;
  onToggleRating?: (rating: "good" | "bad") => void;
  onToggleLeftover?: () => void;
}) {
  const nutritionLine = formatNutritionLine(parsed.nutrition);
  const nameEl = isAdmin ? (
    <button onClick={onClick} style={{ ...valueBtnStyle, width: align === "right" ? "auto" : "100%" }}>
      {parsed.name}
    </button>
  ) : (
    <span style={valueTextStyle}>{parsed.name}</span>
  );
  return (
    <div style={{ textAlign: align }}>
      {nameEl}
      {nutritionLine && (
        <div style={{ ...nutritionLineStyle, textAlign: align }}>{nutritionLine}</div>
      )}
      {parsed.allergens.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 3,
            marginTop: 3,
            justifyContent: align === "right" ? "flex-end" : "flex-start",
          }}
        >
          {parsed.allergens.map((id) => {
            const meta = getAllergenMeta(id);
            return (
              <span key={id} title={`알레르기 유발 성분: ${meta.label}`} style={allergenBadgeStyle}>
                {meta.icon} {meta.label}
              </span>
            );
          })}
        </div>
      )}

      {/* 관리자는 집계된 선호도/잔반 통계를 확인 — 개선에 참고 자료로 씀 */}
      {isAdmin && feedback && (feedback.good || feedback.bad || feedback.leftover) ? (
        <div style={{ ...nutritionLineStyle, textAlign: align, color: "#8a93a3" }}>
          {feedback.good ? `👍${feedback.good}` : null}
          {feedback.bad ? ` 👎${feedback.bad}` : null}
          {feedback.leftover ? ` · 잔반 ${feedback.leftover}건` : null}
        </div>
      ) : null}

      {/* 환자/보호자는 선호도(좋아요/별로예요) + 잔반 여부를 직접 남길 수 있음 */}
      {!isAdmin && onToggleRating && onToggleLeftover && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 3,
            marginTop: 4,
            justifyContent: align === "right" ? "flex-end" : "flex-start",
          }}
        >
          <button
            onClick={() => onToggleRating("good")}
            style={feedbackBtnStyle(myFeedback?.rating === "good")}
          >
            🙂 좋아요
          </button>
          <button
            onClick={() => onToggleRating("bad")}
            style={feedbackBtnStyle(myFeedback?.rating === "bad")}
          >
            🙁 별로예요
          </button>
          <button
            onClick={onToggleLeftover}
            style={feedbackBtnStyle(!!myFeedback?.leftover)}
          >
            🍽️ 잔반 많음
          </button>
        </div>
      )}
    </div>
  );
}

// 편집 중인 칸에서 칼로리/단백질/나트륨을 입력하는 3개 입력창
function NutritionInputsRow({
  nutritionDraft,
  setNutritionDraft,
  onEnter,
}: {
  nutritionDraft: { kcal: string; protein: string; sodium: string };
  setNutritionDraft: Dispatch<SetStateAction<{ kcal: string; protein: string; sodium: string }>>;
  onEnter: () => void;
}) {
  function handleKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") onEnter();
  }
  return (
    <div style={{ display: "flex", gap: 4 }}>
      <input
        type="number"
        inputMode="numeric"
        value={nutritionDraft.kcal}
        placeholder="kcal"
        onChange={(e) => setNutritionDraft((prev) => ({ ...prev, kcal: e.target.value }))}
        onKeyDown={handleKeyDown}
        style={nutritionInputStyle}
      />
      <input
        type="number"
        inputMode="numeric"
        value={nutritionDraft.protein}
        placeholder="단백질(g)"
        onChange={(e) => setNutritionDraft((prev) => ({ ...prev, protein: e.target.value }))}
        onKeyDown={handleKeyDown}
        style={nutritionInputStyle}
      />
      <input
        type="number"
        inputMode="numeric"
        value={nutritionDraft.sodium}
        placeholder="나트륨(mg)"
        onChange={(e) => setNutritionDraft((prev) => ({ ...prev, sodium: e.target.value }))}
        onKeyDown={handleKeyDown}
        style={nutritionInputStyle}
      />
    </div>
  );
}

// 편집 중인 칸에서 알레르기 유발 성분을 다중 선택하는 토글 칩 목록
function AllergenPickerRow({
  allergenDraft,
  setAllergenDraft,
}: {
  allergenDraft: string[];
  setAllergenDraft: Dispatch<SetStateAction<string[]>>;
}) {
  function toggle(id: string) {
    setAllergenDraft((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, padding: "2px 0" }}>
      {ALLERGENS.map((a) => {
        const active = allergenDraft.includes(a.id);
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => toggle(a.id)}
            style={allergenChipStyle(active)}
          >
            {a.icon} {a.label}
          </button>
        );
      })}
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

function NoticeIcon({ variant }: { variant: NoticeVariant }) {
  if (variant === "success") {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2b6cb0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    );
  }
  if (variant === "error") {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#e53e3e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <line x1="12" y1="8" x2="12" y2="13" />
        <line x1="12" y1="16.5" x2="12" y2="16.51" />
      </svg>
    );
  }
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#8a93a3" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="7.5" x2="12" y2="7.51" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#e53e3e"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
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

const nutritionLineStyle: CSSProperties = {
  fontSize: 11,
  color: "#8a93a3",
  marginTop: 2,
  lineHeight: 1.4,
};

const allergenBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 2,
  fontSize: 10,
  color: "#c05621",
  background: "#fffaf0",
  border: "1px solid #feebc8",
  borderRadius: 999,
  padding: "1px 6px",
  whiteSpace: "nowrap",
};

function allergenChipStyle(active: boolean): CSSProperties {
  return {
    fontSize: 11,
    padding: "3px 7px",
    borderRadius: 999,
    border: active ? "1px solid #dd6b20" : "1px solid #d7dbe3",
    background: active ? "#feebc8" : "#fff",
    color: active ? "#9c4221" : "#4a5568",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

function feedbackBtnStyle(active: boolean): CSSProperties {
  return {
    fontSize: 11,
    padding: "3px 7px",
    borderRadius: 999,
    border: active ? "1px solid #2b6cb0" : "1px solid #d7dbe3",
    background: active ? "#ebf4ff" : "#fff",
    color: active ? "#2b6cb0" : "#8a93a3",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

const nutritionInputStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  padding: "5px 6px",
  border: "1px solid #d7dbe3",
  borderRadius: 6,
  fontSize: 12,
  boxSizing: "border-box",
};

const miniSaveBtnStyle: CSSProperties = {
  flex: 1,
  border: "1px solid #2b6cb0",
  background: "#2b6cb0",
  color: "#fff",
  borderRadius: 6,
  padding: "4px 0",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const miniCancelBtnStyle: CSSProperties = {
  flex: 1,
  border: "1px solid #d7dbe3",
  background: "#fff",
  color: "#4a5568",
  borderRadius: 6,
  padding: "4px 0",
  fontSize: 12,
  cursor: "pointer",
};

const modalOverlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 20, 30, 0.5)",
  backdropFilter: "blur(2px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  zIndex: 100,
};

const modalCardStyle: CSSProperties = {
  background: "#fff",
  borderRadius: 16,
  padding: "28px 24px 24px",
  width: "100%",
  maxWidth: 360,
  boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
  textAlign: "center",
};

const modalIconWrapStyle: CSSProperties = {
  width: 52,
  height: 52,
  borderRadius: "50%",
  background: "#fff5f5",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  margin: "0 auto 14px",
};

const modalTitleStyle: CSSProperties = {
  fontSize: 17,
  fontWeight: 700,
  color: "#1f2430",
  margin: "0 0 8px",
};

const modalMessageStyle: CSSProperties = {
  fontSize: 13.5,
  color: "#6b7280",
  lineHeight: 1.6,
  margin: 0,
  whiteSpace: "pre-line",
};

const modalHintStyle: CSSProperties = {
  fontSize: 12.5,
  color: "#8a93a3",
  margin: "14px 0 8px",
};

const modalInputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid #d7dbe3",
  borderRadius: 8,
  padding: "10px 12px",
  fontSize: 14,
  textAlign: "center",
  outline: "none",
};

const modalActionsStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 20,
};

const modalCancelBtnStyle: CSSProperties = {
  flex: 1,
  border: "1px solid #d7dbe3",
  background: "#fff",
  borderRadius: 10,
  padding: "11px 0",
  fontSize: 14,
  fontWeight: 600,
  color: "#4a5568",
  cursor: "pointer",
};

const modalConfirmBtnStyle: CSSProperties = {
  flex: 1,
  border: "1px solid #e53e3e",
  background: "#e53e3e",
  borderRadius: 10,
  padding: "11px 0",
  fontSize: 14,
  fontWeight: 700,
  color: "#fff",
};

function noticeIconWrapStyle(variant: NoticeVariant): CSSProperties {
  const bg = variant === "success" ? "#eef6ff" : variant === "error" ? "#fff5f5" : "#f4f5f7";
  return {
    width: 52,
    height: 52,
    borderRadius: "50%",
    background: bg,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0 auto 14px",
  };
}

function noticeOkBtnStyle(variant: NoticeVariant): CSSProperties {
  const color = variant === "success" ? "#2b6cb0" : variant === "error" ? "#e53e3e" : "#4a5568";
  return {
    flex: 1,
    border: `1px solid ${color}`,
    background: color,
    borderRadius: 10,
    padding: "11px 0",
    fontSize: 14,
    fontWeight: 700,
    color: "#fff",
    cursor: "pointer",
  };
}
