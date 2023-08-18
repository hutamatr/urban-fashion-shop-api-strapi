"use strict";

/**
 * order controller
 */

// @ts-ignore
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const { createCoreController } = require("@strapi/strapi").factories;

module.exports = createCoreController("api::order.order", ({ strapi }) => ({
  async create(ctx) {
    const { products } = ctx.request.body;

    console.log({ products });
    try {
      const lineItems = await Promise.all(
        products.products_list?.map(async (product) => {
          const item = await strapi
            .service("api::product.product")
            .findOne(product?.id);

          return {
            price_data: {
              currency: "usd",
              product_data: {
                name: item?.name,
              },
              unit_amount: Math.round(item?.price * 100),
            },
            quantity: product?.quantity,
          };
        })
      );

      const session = await stripe.checkout.sessions.create({
        shipping_address_collection: { allowed_countries: ["US"] },
        payment_method_types: ["card"],
        mode: "payment",
        success_url:
          process.env.NODE_ENV === "production"
            ? `${process.env.CLIENT_URL_PROD}/`
            : `${process.env.CLIENT_URL_LOCAL}/`,
        cancel_url:
          process.env.NODE_ENV === "production"
            ? `${process.env.CLIENT_URL_PROD}/cart`
            : `${process.env.CLIENT_URL_LOCAL}/cart`,
        line_items: lineItems,
        customer_email: products?.email,
      });

      const newProducts = products.products_list?.map((product) => {
        return {
          id: product?.id,
        };
      });

      await strapi.service("api::order.order").create({
        data: {
          user: products.user_id,
          stripe_id: session.id,
          products_slug: products.products_list,
          products: newProducts,
          total_price: products.total_price,
        },
      });

      return { stripeSession: session };
    } catch (error) {
      ctx.response.status = 500;
      return { error };
    }
  },
}));
