"use client";

import { useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";

const MEAL_TYPES = ["조식", "중식", "석식", "간식"];
const CATEGORIES = ["밥", "국", "반찬A", "반찬B", "반찬C", "반찬D"];
const DAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"];

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

function dateKey(d: Date) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export default function MealPlannerClient({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const today = new Date();
  const [weekStart, setWeekStart] = useState(getMonday(today));
  const [selectedDate, setSelectedDate] = useState(today);
  const [data, setData] = useState<Record<string, string>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // 로그인 관련 상태
  const [showLogin, setShowLogin] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loading, setLoading] = useState(false);

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
    return `${dateKey(selectedDate)}__${mealType}__${category}`;
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
    router.refresh();
  }

  return (
    <div style={{ maxWidth: 960, margin: "40px auto", padding: "0 16px" }}>
      {/* 관리자 로그인/로그아웃 */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        {isAdmin ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, color: "#2b6cb0", fontWeight: 600 }}>
              관리자 모드
            </span>
            <button onClick={handleLogout} style={smallBtnStyle}>
              로그아웃
            </button>
          </div>
        ) : showLogin ? (
          <form
            onSubmit={handleLogin}
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
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
              }}
            />
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
            {loginError && (
              <span style={{ fontSize: 12, color: "#e53e3e" }}>{loginError}</span>
            )}
          </form>
        ) : (
          <button onClick={() => setShowLogin(true)} style={smallBtnStyle}>
            관리자 로그인
          </button>
        )}
      </div>

      {/* 주간 네비게이션 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 20,
          marginBottom: 24,
        }}
      >
        <button onClick={goPrevWeek} aria-label="이전 주" style={navBtnStyle}>
          ◀
        </button>
        <button onClick={goToday} style={dateBtnStyle}>
          {formatDate(weekStart)} ~ {formatDate(weekEnd)}
        </button>
        <button onClick={goNextWeek} aria-label="다음 주" style={navBtnStyle}>
          ▶
        </button>
      </div>

      {/* 요일 탭 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20, justifyContent: "center" }}>
        {days.map((d, i) => {
          const active = isSameDay(d, selectedDate);
          const isToday = isSameDay(d, today);
          return (
            <button
              key={i}
              onClick={() => setSelectedDate(d)}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: active ? "2px solid #2b6cb0" : "1px solid #e2e5ea",
                background: active ? "#ebf4ff" : "#fff",
                cursor: "pointer",
                minWidth: 64,
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

      {/* 표 */}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
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
              {CATEGORIES.map((category) => {
                const key = cellKey(mealType, category);
                const value = data[key];
                const isEditing = editingKey === key;
                return (
                  <td key={category} style={tdStyle}>
                    {isEditing ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => saveEdit(key)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit(key);
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
  );
}

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
