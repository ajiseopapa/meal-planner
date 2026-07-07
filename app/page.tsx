import { cookies } from "next/headers";
import { ADMIN_COOKIE_NAME, verifySessionToken } from "@/lib/adminAuth";
import MealPlannerClient from "./MealPlannerClient";

export default async function MealPlannerPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
  const isAdmin = verifySessionToken(token);

  return <MealPlannerClient isAdmin={isAdmin} />;
}
