const utils = require("@strapi/utils");
const { getService } = require("../users-permissions/utils");
const jwt = require("jsonwebtoken");

const _ = require("lodash");

const {
  validateCallbackBody,
  validateRegisterBody,
  validateSendEmailConfirmationBody,
} = require("../users-permissions/controllers/validation/auth");
const { setMaxListeners } = require("process");

const { sanitize } = utils;
const { ApplicationError, ValidationError } = utils.errors;

const emailRegExp =
  /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;

const sanitizeUser = (user, ctx) => {
  const { auth } = ctx.state;
  const userSchema = strapi.getModel("plugin::users-permissions.user");

  return sanitize.contentAPI.output(user, userSchema, { auth });
};

// issue a JWT
const issueJWT = (payload, jwtOptions = {}) => {
  _.defaults(jwtOptions, strapi.config.get("plugin.users-permissions.jwt"));
  return jwt.sign(
    _.clone(payload.toJSON ? payload.toJSON() : payload),
    strapi.config.get("plugin.users-permissions.jwtSecret"),
    jwtOptions
  );
};

// verify the refreshToken by using the REFRESH_SECRET from the .env
const verifyRefreshToken = (token) => {
  return new Promise(function (resolve, reject) {
    jwt.verify(
      token,
      process.env.REFRESH_SECRET,
      {},
      function (err, tokenPayload = {}) {
        if (err) {
          return reject(new Error("Invalid token."));
        }
        resolve(tokenPayload);
      }
    );
  });
};

// issue a Refresh token
const issueRefreshToken = (payload, jwtOptions = {}) => {
  _.defaults(jwtOptions, strapi.config.get("plugin.users-permissions.jwt"));
  return jwt.sign(
    _.clone(payload.toJSON ? payload.toJSON() : payload),
    process.env.REFRESH_SECRET,
    { expiresIn: process.env.REFRESH_TOKEN_EXPIRES }
  );
};

module.exports = (plugin) => {
  // replace the following code line
  //  async callback(ctx) {

  // with
  plugin.controllers.auth.callback = async (ctx) => {
    const provider = ctx.params.provider || "local";
    const params = ctx.request.body;

    const store = await strapi.store({
      type: "plugin",
      name: "users-permissions",
    });
    if (provider === "local") {
      if (!_.get(await store.get({ key: "grant" }), "email.enabled")) {
        throw new ApplicationError("This provider is disabled");
      }

      // @ts-ignore
      await validateCallbackBody(params);

      const query = { provider };

      // Check if the provided identifier is an email or not.
      const isEmail = emailRegExp.test(params.identifier);

      // Set the identifier to the appropriate query field.
      if (isEmail) {
        query.email = params.identifier.toLowerCase();
      } else {
        query.username = params.identifier;
      }

      // Check if the user exists.
      const user = await strapi
        .query("plugin::users-permissions.user")
        .findOne({ where: query });

      if (!user) {
        throw new ValidationError("Invalid identifier or password");
      }

      if (
        _.get(await store.get({ key: "advanced" }), "email_confirmation") &&
        user.confirmed !== true
      ) {
        throw new ApplicationError("Your account email is not confirmed");
      }

      if (user.blocked === true) {
        throw new ApplicationError(
          "Your account has been blocked by an administrator"
        );
      }

      // The user never authenticated with the `local` provider.
      if (!user.password) {
        throw new ApplicationError(
          "This user never set a local password, please login with the provider used during account creation"
        );
      }

      const validPassword = await getService("user").validatePassword(
        params.password,
        user.password
      );

      if (!validPassword) {
        throw new ValidationError("Invalid identifier or password");
      } else {
        /*ctx.cookies.set("jwt", data.jwt, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production" ? true : false,
          maxAge: 1000 * 60 * 60 * 24 * 14, // 14 Day Age
          domain: process.env.NODE_ENV === "development"
                  ? "localhost" : process.env.PRODUCTION_URL,
        }); */

        const refreshToken = issueRefreshToken({ id: user.id });
        ctx.cookies.set("refreshToken", refreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          maxAge: 1000 * 60 * 60 * 24 * 14, // 14 Day Age
          domain:
            process.env.NODE_ENV === "development"
              ? process.env.CLIENT_URL_LOCAL
              : process.env.CLIENT_URL_PROD,
          sameSite: "strict",
        });
        ctx.send({
          jwt: issueJWT(
            { id: user.id },
            { expiresIn: process.env.JWT_SECRET_EXPIRES }
          ),
          refreshToken: refreshToken,
          /* jwt: getService('jwt').issue({ id: user.id }), */
          user: await sanitizeUser(user, ctx),
        });
      }
    } else {
      if (!_.get(await store.get({ key: "grant" }), [provider, "enabled"])) {
        throw new ApplicationError("This provider is disabled");
      }

      // Connect the user with the third-party provider.
      let user;
      let error;
      try {
        [user, error] = await getService("providers").connect(
          provider,
          ctx.query
        );
      } catch ([user, error]) {
        throw new ApplicationError(error.message);
      }

      if (!user) {
        throw new ApplicationError(error.message);
      }

      ctx.send({
        jwt: getService("jwt").issue({ id: user.id }),
        user: await sanitizeUser(user, ctx),
      });
    }
  };

  plugin.controllers.auth.register = async (ctx) => {
    const pluginStore = await strapi.store({
      type: "plugin",
      name: "users-permissions",
    });

    const settings = await pluginStore.get({ key: "advanced" });

    if (!settings.allow_register) {
      throw new ApplicationError("Register action is currently disabled");
    }

    const params = {
      ..._.omit(ctx.request.body, [
        "confirmed",
        "blocked",
        "confirmationToken",
        "resetPasswordToken",
        "provider",
        "id",
        "createdAt",
        "updatedAt",
        "createdBy",
        "updatedBy",
        "role",
      ]),
      provider: "local",
    };

    // @ts-ignore
    await validateRegisterBody(params);

    const role = await strapi
      .query("plugin::users-permissions.role")
      .findOne({ where: { type: settings.default_role } });

    if (!role) {
      throw new ApplicationError("Impossible to find the default role");
    }

    // @ts-ignore
    const { email, username, provider } = params;

    const identifierFilter = {
      $or: [
        { email: email.toLowerCase() },
        { username: email.toLowerCase() },
        { username },
        { email: username },
      ],
    };

    const conflictingUserCount = await strapi
      .query("plugin::users-permissions.user")
      .count({
        where: { ...identifierFilter, provider },
      });

    if (conflictingUserCount > 0) {
      throw new ApplicationError("Email or Username are already taken");
    }

    if (settings.unique_email) {
      const conflictingUserCount = await strapi
        .query("plugin::users-permissions.user")
        .count({
          where: { ...identifierFilter },
        });

      if (conflictingUserCount > 0) {
        throw new ApplicationError("Email or Username are already taken");
      }
    }

    const newUser = {
      ...params,
      role: role.id,
      email: email.toLowerCase(),
      username,
      confirmed: !settings.email_confirmation,
    };

    const user = await getService("user").add(newUser);

    const sanitizedUser = await sanitizeUser(user, ctx);

    if (settings.email_confirmation) {
      try {
        await getService("user").sendConfirmationEmail(sanitizedUser);
      } catch (err) {
        throw new ApplicationError(err.message);
      }

      return ctx.send({ user: sanitizedUser });
    }

    const jwt = getService("jwt").issue(_.pick(user, ["id"]));
    const refreshToken = issueRefreshToken({ id: user.id });
    ctx.cookies.set("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 14, // 14 Day Age
      domain:
        process.env.NODE_ENV === "development"
          ? process.env.CLIENT_URL_LOCAL
          : process.env.CLIENT_URL_PROD,
      sameSite: "strict",
    });

    return ctx.send({
      jwt,
      refreshToken,
      user: sanitizedUser,
    });
  };

  /**
   * Creating a new token based on the refreshCookie
   *
   *
   * @param {*} ctx
   * @returns
   */

  plugin.controllers.auth["refreshToken"] = async (ctx) => {
    // get token from the POST request
    const store = await strapi.store({
      type: "plugin",
      name: "users-permissions",
    });

    // either as Cookie or in the body as refreshToken
    const { refreshToken } = ctx.request.body;

    let refreshCookie = ctx.cookies.get("refreshToken");

    if (!refreshCookie && !refreshToken) {
      return ctx.badRequest("no Authorization");
    }
    if (!refreshCookie) {
      if (refreshToken) {
        // in case we get the token in the body
        refreshCookie = refreshToken;
      } else {
        return ctx.badRequest("no Authorization");
      }
    }

    try {
      const obj = await verifyRefreshToken(refreshCookie);
      // Check if the user exists.
      const user = await strapi
        .query("plugin::users-permissions.user")
        .findOne({ where: { id: obj.id } });
      if (!user) {
        throw new ValidationError("Invalid identifier or password");
      }

      if (
        _.get(await store.get({ key: "advanced" }), "email_confirmation") &&
        user.confirmed !== true
      ) {
        throw new ApplicationError("Your account email is not confirmed");
      }

      if (user.blocked === true) {
        throw new ApplicationError(
          "Your account has been blocked by an administrator"
        );
      }
      const refreshToken = issueRefreshToken({ id: user.id });
      ctx.cookies.set("refreshToken", refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        maxAge: 1000 * 60 * 60 * 24 * 14, // 14 Day Age
        domain:
          process.env.NODE_ENV === "development"
            ? process.env.CLIENT_URL_LOCAL
            : process.env.CLIENT_URL_PROD,
        sameSite: "strict",
      });
      ctx.send({
        jwt: issueJWT(
          { id: obj.id },
          { expiresIn: process.env.JWT_SECRET_EXPIRES }
        ),
        refreshToken: refreshToken,
        /* jwt: getService('jwt').issue({ id: user.id }), */
      });
    } catch (err) {
      return ctx.badRequest(err.toString());
    }
  };

  plugin.controllers.auth["logout"] = async (ctx) => {
    // delete the refresh cookie
    ctx.cookies.set("refreshToken", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 14, // 14 Day Age
      domain:
        process.env.NODE_ENV === "development"
          ? process.env.CLIENT_URL_LOCAL
          : process.env.CLIENT_URL_PROD,
      sameSite: "strict",
    });
    ctx.send({
      message: "ok",
    });
  };

  plugin.routes["content-api"].routes.push({
    method: "POST",
    path: "/token/refresh",
    handler: "auth.refreshToken",
    config: {
      policies: [],
      prefix: "",
    },
  });

  plugin.routes["content-api"].routes.push({
    method: "GET",
    path: "/auth/logout",
    handler: "auth.logout",
    config: {
      policies: [],
      prefix: "",
    },
  });

  return plugin;
};
