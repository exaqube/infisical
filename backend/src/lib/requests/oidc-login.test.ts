import { mapOidcUserInfo } from "./oidc-login";

describe("mapOidcUserInfo", () => {
  test("maps standard claims and trusts email_verified only when it is boolean true", () => {
    expect(
      mapOidcUserInfo({
        sub: "user_1",
        email: " Jane@Example.com ",
        email_verified: true,
        given_name: "Jane",
        family_name: "Doe"
      })
    ).toEqual({
      providerUserId: "user_1",
      email: "jane@example.com",
      firstName: "Jane",
      lastName: "Doe",
      isEmailVerifiedByProvider: true
    });
  });

  test.each([false, "true", 1, undefined])("email_verified=%s is not trusted", (emailVerified) => {
    expect(
      mapOidcUserInfo({ sub: "u", email: "a@b.co", email_verified: emailVerified })?.isEmailVerifiedByProvider
    ).toBe(false);
  });

  test("splits name when given/family names are absent, falls back to the email local part", () => {
    expect(mapOidcUserInfo({ sub: "u", email: "a@b.co", name: "Ada  Mary Lovelace" })).toMatchObject({
      firstName: "Ada",
      lastName: "Mary Lovelace"
    });
    expect(mapOidcUserInfo({ sub: "u", email: "ada@b.co" })).toMatchObject({ firstName: "ada", lastName: "" });
  });

  test("returns null without a subject or an email", () => {
    expect(mapOidcUserInfo({ email: "a@b.co" })).toBeNull();
    expect(mapOidcUserInfo({ sub: "u" })).toBeNull();
  });
});
