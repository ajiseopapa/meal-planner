import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE_NAME, verifySessionToken } from "@/lib/adminAuth";
import { getAdminDb } from "@/lib/firebaseAdmin";

// 직접 추가한 알레르기 이름 목록은 "customAllergens/list" 문서 하나에
// labels: string[] 형태로 통째로 저장합니다. (recentMenus와 동일하게
// 클라이언트가 다음 상태를 계산해서 매번 전체 배열을 덮어씁니다)
const MAX_LABELS = 60;
const MAX_LABEL_LENGTH = 20;

function isValidLabels(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= MAX_LABELS &&
    v.every((x) => typeof x === "string" && x.trim().length > 0 && x.trim().length <= MAX_LABEL_LENGTH)
  );
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
  const isAdmin = verifySessionToken(token);

  if (!isAdmin) {
    return NextResponse.json(
      { ok: false, message: "관리자 권한이 필요합니다." },
      { status: 401 }
    );
  }

  const body = await req.json().catch(() => null);
  const rawLabels = body?.labels;

  if (!isValidLabels(rawLabels)) {
    return NextResponse.json(
      { ok: false, message: "요청 형식이 올바르지 않습니다." },
      { status: 400 }
    );
  }

  // 트림 + 중복 제거
  const labels = Array.from(new Set(rawLabels.map((l) => l.trim())));

  const adminDb = getAdminDb();
  await adminDb.collection("customAllergens").doc("list").set({
    labels,
    updatedAt: new Date(),
  });

  return NextResponse.json({ ok: true, count: labels.length });
}
