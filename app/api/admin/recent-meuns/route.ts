import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE_NAME, verifySessionToken } from "@/lib/adminAuth";
import { getAdminDb } from "@/lib/firebaseAdmin";

type RecentMenuEntryInput = {
  name: string;
  kcal?: number;
  protein?: number;
  sodium?: number;
  allergens?: string[];
};

function isValidEntry(e: unknown): e is RecentMenuEntryInput {
  if (!e || typeof e !== "object") return false;
  const r = e as Record<string, unknown>;
  if (typeof r.name !== "string") return false;
  if (r.kcal !== undefined && typeof r.kcal !== "number") return false;
  if (r.protein !== undefined && typeof r.protein !== "number") return false;
  if (r.sodium !== undefined && typeof r.sodium !== "number") return false;
  if (r.allergens !== undefined) {
    if (!Array.isArray(r.allergens)) return false;
    if (!r.allergens.every((a) => typeof a === "string")) return false;
  }
  return true;
}

// 카테고리(밥/국/반찬A 등)별 "최근 등록한 메뉴" 목록을 통째로 덮어씁니다.
// 목록 자체(최대 개수 제한, 중복 제거)는 클라이언트에서 이미 계산해서 보내주므로
// 여기서는 형식만 검증하고 그대로 저장합니다.
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
  const category = body?.category;
  const entries = body?.entries;

  if (
    typeof category !== "string" ||
    category.trim() === "" ||
    !Array.isArray(entries) ||
    !entries.every(isValidEntry)
  ) {
    return NextResponse.json(
      { ok: false, message: "요청 형식이 올바르지 않습니다." },
      { status: 400 }
    );
  }

  const adminDb = getAdminDb();
  const ref = adminDb.collection("recentMenus").doc(category);

  await ref.set({
    entries: (entries as RecentMenuEntryInput[]).map((e) => ({
      name: e.name.trim(),
      ...(e.kcal !== undefined ? { kcal: e.kcal } : {}),
      ...(e.protein !== undefined ? { protein: e.protein } : {}),
      ...(e.sodium !== undefined ? { sodium: e.sodium } : {}),
      ...(e.allergens !== undefined ? { allergens: e.allergens } : {}),
    })),
    updatedAt: new Date(),
  });

  return NextResponse.json({ ok: true });
}
