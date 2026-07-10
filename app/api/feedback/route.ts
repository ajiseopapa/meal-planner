import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";

// 환자/보호자가 남기는 "선호도(좋아요/별로예요) + 잔반" 피드백을 저장하는 공개 API입니다.
// 관리자 로그인 없이 누구나 호출할 수 있지만, 대상 문서는 meals와 별도의 "feedback"
// 컬렉션이라 식단 데이터 자체를 건드리지 않습니다.
//
// delta 방식으로 카운터를 증감시킵니다. 클라이언트는 브라우저에 "이미 눌렀는지"를
// localStorage로 기억해두고, 같은 버튼을 다시 누르면 delta: -1로 취소 요청을 보냅니다.

type FeedbackKind = "good" | "bad" | "leftover";

type FeedbackInput = {
  key: string; // 식단 칸과 동일한 key (date__diet__mealType__category)
  date: string; // YYYY-MM-DD
  diet: string;
  mealType: string;
  category: string;
  kind: FeedbackKind;
  delta: 1 | -1; // 1: 추가, -1: 취소
  comment?: string; // "별로예요"를 고를 때 남기는 짧은 이유(선택)
};

function isValidInput(u: unknown): u is FeedbackInput {
  if (!u || typeof u !== "object") return false;
  const r = u as Record<string, unknown>;
  return (
    typeof r.key === "string" &&
    typeof r.date === "string" &&
    typeof r.diet === "string" &&
    typeof r.mealType === "string" &&
    typeof r.category === "string" &&
    (r.kind === "good" || r.kind === "bad" || r.kind === "leftover") &&
    (r.delta === 1 || r.delta === -1) &&
    (r.comment === undefined || typeof r.comment === "string")
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);

  if (!isValidInput(body)) {
    return NextResponse.json(
      { ok: false, message: "요청 형식이 올바르지 않습니다." },
      { status: 400 }
    );
  }

  const db = getAdminDb();
  const ref = db.collection("feedback").doc(body.key);

  const update: Record<string, unknown> = {
    date: body.date,
    diet: body.diet,
    mealType: body.mealType,
    category: body.category,
    [body.kind]: FieldValue.increment(body.delta),
    updatedAt: new Date(),
  };

  // 짧은 이유 코멘트는 최근 것만 몇 개 보관 (너무 길어지지 않도록 200자로 자름)
  if (body.delta === 1 && body.comment && body.comment.trim() !== "") {
    update.comments = FieldValue.arrayUnion(body.comment.trim().slice(0, 200));
  }

  await ref.set(update, { merge: true });

  return NextResponse.json({ ok: true });
}
