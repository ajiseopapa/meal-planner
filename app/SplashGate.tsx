'use client';

import { useEffect, useState } from 'react';

export default function SplashGate({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(true);
  const [fadeOut, setFadeOut] = useState(false);

  useEffect(() => {
    const fadeTimer = setTimeout(() => setFadeOut(true), 1200);
    const removeTimer = setTimeout(() => setVisible(false), 1500);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(removeTimer);
    };
  }, []);

  return (
    <>
      {visible && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            height: '100dvh',
            background: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            opacity: fadeOut ? 0 : 1,
            transition: 'opacity 0.3s ease',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            <h1
              style={{
                fontSize: '22px',
                fontWeight: 600,
                color: '#222',
                textAlign: 'center',
                padding: '0 20px',
                margin: 0,
              }}
            >
              세계로병원 환자식 메뉴 안내
            </h1>
            <svg
              width="56"
              height="56"
              viewBox="0 0 100 100"
              style={{ animation: 'splash-float 1.6s ease-in-out infinite' }}
            >
              <path d="M15 50 Q15 82 50 88 Q85 82 85 50 Z" fill="#d97a52" stroke="#b85c3a" strokeWidth="2" />
              <ellipse cx="50" cy="50" rx="36" ry="9" fill="#f2a97a" stroke="#b85c3a" strokeWidth="2" />
              <path
                d="M22 48 Q28 30 50 28 Q72 30 78 48 Q65 42 50 42 Q35 42 22 48 Z"
                fill="#fff9ec"
                stroke="#e8dcc0"
                strokeWidth="1.5"
              />
              <ellipse cx="38" cy="35" rx="4" ry="2.5" fill="#ffffff" />
              <ellipse cx="55" cy="32" rx="4" ry="2.5" fill="#ffffff" />
              <ellipse cx="65" cy="38" rx="4" ry="2.5" fill="#ffffff" />
              <circle cx="42" cy="46" r="2.2" fill="#3a2a1a" />
              <circle cx="58" cy="46" r="2.2" fill="#3a2a1a" />
              <path d="M46 51 Q50 54 54 51" stroke="#3a2a1a" strokeWidth="1.8" fill="none" strokeLinecap="round" />
              <circle cx="36" cy="49" r="2.5" fill="#f4a3a3" opacity="0.7" />
              <circle cx="64" cy="49" r="2.5" fill="#f4a3a3" opacity="0.7" />
            </svg>
          </div>
          <style>{`
            @keyframes splash-float {
              0%, 100% { transform: translateY(0); }
              50% { transform: translateY(-8px); }
            }
          `}</style>
        </div>
      )}
      {children}
    </>
  );
}
