/**
 * @fileoverview WebMCP tool template definitions.
 * @description Exports canonical tool templates and field hint metadata used by the wrapper annotation flow and AI mapping steps.
 */

export const WebMCPToolTemplates = [
  {
    id: "add_to_cart",
    name: "Add to Cart",
    description: "Add a specific product or variant with an optional quantity to the shopping cart.",
    defaultToolName: "add_to_cart",
    defaultToolDescription: "Add the selected item/variant and quantity to the cart.",
    fields: [
      {
        id: "product_name",
        label: "Product Name",
        required: false,
        webmcpTarget: "metadata",
        domHints: {
          tags: ["h1", "h2", "h3", "h4", "span", "div"],
          textKeywords: [],
          ariaKeywords: ["heading"]
        },
        visionHints: {
          elementTypes: ["heading", "title_text"],
          textPatterns: []
        }
      },
      {
        id: "id",
        label: "Product / Variant ID",
        required: false,
        webmcpTarget: "param",
        domHints: {
          tags: ["input", "select", "div"],
          typeKeywords: ["hidden", "radio"],
          textKeywords: ["variant", "option", "size", "color"],
          ariaKeywords: ["listbox", "radiogroup"]
        },
        visionHints: {
          elementTypes: ["select_dropdown", "radio_group", "button_group", "hidden_input"],
          textPatterns: ["size", "color", "model", "variant"]
        }
      },
      {
        id: "quantity",
        label: "Quantity",
        required: false,
        webmcpTarget: "param",
        domHints: {
          tags: ["input", "select"],
          typeKeywords: ["number", "text"],
          textKeywords: ["qty", "quantity", "amount"],
          ariaKeywords: ["spinbutton"]
        },
        visionHints: {
          elementTypes: ["number_input", "stepper", "select_dropdown"],
          textPatterns: ["qty", "quantity"]
        }
      },
      {
        id: "add_to_cart_button",
        label: "Add to Cart Button",
        required: true,
        webmcpTarget: "cta",
        domHints: {
          tags: ["button", "input", "a"],
          typeKeywords: ["submit", "button"],
          textKeywords: ["add to cart", "add to bag", "buy", "purchase"],
          ariaKeywords: ["button"]
        },
        visionHints: {
          elementTypes: ["button", "submit_button", "cta_link"],
          textPatterns: ["add to cart", "add to bag", "buy now", "purchase"]
        }
      },
      {
        id: "description",
        label: "Product Description",
        required: false,
        webmcpTarget: "metadata",
        domHints: {
          tags: ["div", "section", "article", "p", "details"],
          textKeywords: ["description", "detail", "overview", "about"],
          ariaKeywords: []
        },
        visionHints: {
          elementTypes: ["text_block", "expandable_section"],
          textPatterns: ["description", "details", "overview"]
        }
      }
    ]
  },
  {
    id: "search_products",
    name: "Product Search",
    description: "Search products in the site's catalog.",
    defaultToolName: "search_products",
    defaultToolDescription: "Search products in the catalog using keywords.",
    fields: [
      {
        id: "search_query",
        label: "Search Query",
        required: true,
        webmcpTarget: "param",
        domHints: {
          tags: ["input", "textarea"],
          typeKeywords: ["text", "search"],
          textKeywords: ["search", "query", "find", "look"],
          ariaKeywords: ["searchbox", "search"]
        },
        visionHints: {
          elementTypes: ["text_input", "search_input"],
          textPatterns: ["search", "find", "look for"]
        }
      },
      {
        id: "search_button",
        label: "Search Button",
        required: true,
        webmcpTarget: "cta",
        domHints: {
          tags: ["button", "input"],
          typeKeywords: ["submit", "button"],
          textKeywords: ["search", "go", "find"],
          ariaKeywords: ["button"]
        },
        visionHints: {
          elementTypes: ["button", "submit_button"],
          textPatterns: ["search", "go", "find"]
        }
      }
    ]
  }
];
