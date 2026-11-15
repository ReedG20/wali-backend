// Clerk (dev instance) issues a JWT from its "convex" template; Convex verifies it here.
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN!,
      applicationID: "convex",
    },
  ],
};
