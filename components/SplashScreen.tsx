"use client";

import { useEffect, useState } from "react";

/**
 * 앱 오픈 시 잠깐 보여주는 스플래시(로딩) 화면.
 * - loading.png 는 /public 폴더에 넣어주세요.
 * - 사용법: app/layout.tsx(또는 최상위 페이지)에서 <SplashScreen /> 를 렌더하면 됩니다.
 */
export default function SplashScreen({ duration = 1600 }: { duration?: number }) {
  const [hidden, setHidden] = useState(false);   // DOM 제거
  const [fading, setFading] = useState(false);   // 페이드아웃 시작

  useEffect(() => {
    const t1 = setTimeout(() => setFading(true), duration);
    const t2 = setTimeout(() => setHidden(true), duration + 500); // 페이드 시간 500ms
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [duration]);

  if (hidden) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "24px",
        background: "#fffaf3",
        opacity: fading ? 0 : 1,
        transition: "opacity 0.5s ease",
        pointerEvents: fading ? "none" : "auto",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/loading.png"
        alt="로딩 중"
        width={220}
        style={{
          width: "min(55vw, 220px)",
          height: "auto",
          animation: "splashBounce 1.1s ease-in-out infinite",
        }}
      />
      <p
        style={{
          margin: 0,
          fontSize: "1.05rem",
          fontWeight: 600,
          color: "#b5622f",
          letterSpacing: "0.02em",
        }}
      >
        식단표를 준비하고 있어요…
      </p>

      <style>{`
        @keyframes splashBounce {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-14px); }
        }
      `}</style>
    </div>
  );
}
