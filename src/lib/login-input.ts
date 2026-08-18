import { z } from "zod";

import { AUTH_PASSWORD_MAX_CHARACTERS, AUTH_PASSWORD_MAX_UTF8_BYTES, countUnicodeCharacters, getUtf8ByteLength, isWellFormedUnicode, LOGIN_REQUEST_MAX_BYTES, LOGIN_USERNAME_MAX_CHARACTERS, LOGIN_USERNAME_MAX_UTF8_BYTES } from "@/lib/auth-credential-policy.mjs";
import { parseBoundedJsonBody } from "@/lib/http";

const loginSchema = z.object({
  username: z.string().min(1, "Username is required.").refine(isWellFormedUnicode, "Username must contain well-formed Unicode.").refine((value) => countUnicodeCharacters(value) <= LOGIN_USERNAME_MAX_CHARACTERS, `Username must not exceed ${LOGIN_USERNAME_MAX_CHARACTERS} characters.`).refine((value) => getUtf8ByteLength(value) <= LOGIN_USERNAME_MAX_UTF8_BYTES, `Username must not exceed ${LOGIN_USERNAME_MAX_UTF8_BYTES} UTF-8 bytes.`),
  password: z.string().min(1, "Password is required.").refine(isWellFormedUnicode, "Password must contain well-formed Unicode.").refine((value) => countUnicodeCharacters(value) <= AUTH_PASSWORD_MAX_CHARACTERS, `Password must not exceed ${AUTH_PASSWORD_MAX_CHARACTERS} characters.`).refine((value) => getUtf8ByteLength(value) <= AUTH_PASSWORD_MAX_UTF8_BYTES, `Password must not exceed ${AUTH_PASSWORD_MAX_UTF8_BYTES} UTF-8 bytes.`),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const parseLoginRequest = async (request: Request): Promise<LoginInput> => {
  const body = await parseBoundedJsonBody<unknown>(request, { bodyName: "Login", maxBytes: LOGIN_REQUEST_MAX_BYTES });
  return loginSchema.parse(body);
};
