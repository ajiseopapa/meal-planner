import crypto from "crypto";

export const ADMIN_COOKIE_NAME = "admin_session";
const SESSION_VALUE = "admin"; // 쿠키에 담길 실제 내용(고정값), 서명으로만 위조 방지

function getSecret() {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    throw new Error(
      ".env.local에 ADMIN_SECRET이 설정되어 있지 않습니다. (예: ADMIN_SECRET=아무렇게나-긴-문자열)"
    );
  }
  return secret;
}

// 서명된 세션 토큰 생성: "admin.<hmac>"
export function createSessionToken() {
  const hmac = crypto.createHmac("sha256", getSecret()).update(SESSION_VALUE).digest("hex");
  return `${SESSION_VALUE}.${hmac}`;
}

// 쿠키 값이 우리가 발급한 토큰이 맞는지 검증
export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const [value, hmac] = token.split(".");
  if (value !== SESSION_VALUE || !hmac) return false;
  const expected = crypto.createHmac("sha256", getSecret()).update(SESSION_VALUE).digest("hex");
  // 타이밍 공격 방지를 위해 timingSafeEqual 사용
  const a = Buffer.from(hmac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function checkPassword(password: string): boolean {
  const real = process.env.ADMIN_PASSWORD;
  if (!real) {
    throw new Error(
      ".env.local에 ADMIN_PASSWORD가 설정되어 있지 않습니다. (예: ADMIN_PASSWORD=원하는비밀번호)"
    );
  }
  return password === real;
}
