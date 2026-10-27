/**
 * OpenAPI 3.0.3 Specification and Swagger UI generator
 * for ZIMRA FDMS Fiscal Gateway.
 * Minimalist, developer-first documentation.
 */

export function getOpenApiSpec(serverBaseUrl = "http://localhost:3000"): Record<string, any> {
  return {
    openapi: "3.0.3",
    info: {
      title: "ZIMRA FDMS Gateway",
      version: "0.4.1",
      description: "Fiscalisation REST API. Auth: `X-API-Key: zf_live_...` or Bearer token.",
    },
    servers: [
      {
        url: serverBaseUrl,
        description: "Gateway API",
      },
    ],
    tags: [
      { name: "Havano POS Integration", description: "Direct plug-and-play endpoints for Havano POS" },
      { name: "Fiscal Documents", description: "Invoices, Credit/Debit Notes, Deposits" },
      { name: "Fiscal Receipts", description: "Submit & ledger" },
      { name: "Fiscal Days", description: "Day open/close" },
      { name: "Virtual Devices", description: "Device & mTLS" },
      { name: "Offline Queue", description: "Buffer & sync" },
      { name: "Stores & Organizations", description: "Stores & tax info" },
      { name: "Authentication", description: "Auth & API keys" },
      { name: "System & Health", description: "Health checks" },
      { name: "SuperAdmin", description: "Fleet management" },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description: "Tenant API Key",
        },
        BearerAuth: {
          type: "http",
          scheme: "bearer",
        },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          properties: {
            error: { type: "string", example: "Invalid credentials or unauthorized" },
            hint: { type: "string", example: "Verify credentials or active fiscal day status" },
            operationId: { type: "string", example: "op_987654" },
          },
        },
        Store: {
          type: "object",
          properties: {
            id: { type: "string", example: "str_9f81a7b2" },
            tenant_id: { type: "string", example: "tnt_83ab921c" },
            name: { type: "string", example: "Havano Megastore Harare CBD" },
            email: { type: "string", format: "email", example: "harare-cbd@havano.co.zw" },
            phone: { type: "string", example: "+263 77 123 4567" },
            city: { type: "string", example: "Harare" },
            address: { type: "string", example: "123 Samora Machel Avenue" },
            province: { type: "string", example: "Harare Province" },
            postal_code: { type: "string", example: "00263" },
            country: { type: "string", example: "Zimbabwe" },
            tin: { type: "string", example: "2001234567" },
            vat_number: { type: "string", example: "10023456" },
            currency: { type: "string", example: "USD" },
            branch_name: { type: "string", example: "Main Branch" },
            contact_person: { type: "string", example: "Farai Moyo" },
            business_type: { type: "string", example: "Retail & Supermarket" },
            status: { type: "string", example: "active" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        CreateStoreRequest: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", example: "Havano Megastore Bulawayo" },
            email: { type: "string", format: "email", example: "bulawayo@havano.co.zw" },
            phone: { type: "string", example: "+263 71 987 6543" },
            city: { type: "string", example: "Bulawayo" },
            address: { type: "string", example: "45 Jason Moyo Street" },
            province: { type: "string", example: "Bulawayo" },
            postal_code: { type: "string", example: "00263" },
            country: { type: "string", default: "Zimbabwe", example: "Zimbabwe" },
            tin: { type: "string", example: "2001234567" },
            vat_number: { type: "string", example: "10023456" },
            currency: { type: "string", default: "USD", example: "USD" },
            branch_name: { type: "string", default: "Bulawayo Central" },
            contact_person: { type: "string", example: "Tariro Ndlovu" },
            business_type: { type: "string", default: "Retail" },
            status: { type: "string", default: "active" },
          },
        },
        UpdateStoreRequest: {
          type: "object",
          properties: {
            name: { type: "string", example: "Havano Megastore Harare CBD" },
            email: { type: "string", format: "email", example: "harare-cbd@havano.co.zw" },
            phone: { type: "string", example: "+263 77 123 4567" },
            city: { type: "string", example: "Harare" },
            address: { type: "string", example: "125 Samora Machel Avenue" },
            province: { type: "string", example: "Harare Province" },
            postal_code: { type: "string", example: "00263" },
            country: { type: "string", example: "Zimbabwe" },
            tin: { type: "string", example: "2001234567" },
            vat_number: { type: "string", example: "10023456" },
            currency: { type: "string", example: "USD" },
            branch_name: { type: "string", example: "Flagship Branch" },
            contact_person: { type: "string", example: "Farai Moyo" },
            business_type: { type: "string", example: "Retail & Wholesale" },
            status: { type: "string", example: "active" },
          },
        },
        ReceiptLine: {
          type: "object",
          required: ["name", "price", "quantity"],
          properties: {
            name: { type: "string", example: "Wireless Barcode Scanner" },
            price: { type: "number", example: 115.00 },
            quantity: { type: "number", example: 1 },
            taxId: { type: "integer", example: 1 },
            taxPercent: { type: "number", example: 15.0 },
            hsCode: { type: "string", example: "8471.60.00" },
          },
        },
        ReceiptPayment: {
          type: "object",
          required: ["moneyType", "amount"],
          properties: {
            moneyType: { type: "string", enum: ["Cash", "Card", "Ecocash", "BankTransfer", "Credit"], example: "Cash" },
            amount: { type: "number", example: 115.00 },
          },
        },
        ReceiptSubmitRequest: {
          type: "object",
          required: ["receiptType", "currency", "lines", "payments"],
          properties: {
            deviceId: { type: "integer", example: 12345 },
            serialNumber: { type: "string", example: "MYPOS01" },
            receiptType: { type: "string", enum: ["FiscalInvoice", "CreditNote", "DebitNote"], example: "FiscalInvoice" },
            invoiceNo: { type: "string", example: "INV-2026-0042" },
            currency: { type: "string", example: "USD" },
            linesTaxInclusive: { type: "boolean", default: true, example: true },
            lines: {
              type: "array",
              items: { $ref: "#/components/schemas/ReceiptLine" },
            },
            payments: {
              type: "array",
              items: { $ref: "#/components/schemas/ReceiptPayment" },
            },
            mode: { type: "string", enum: ["online", "offline"], example: "online" },
            operatingMode: { type: "string", enum: ["OnlineOnly", "QueueOnFailure"], example: "QueueOnFailure" },
          },
        },
        ReceiptSubmitResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            queued: { type: "boolean", example: false },
            receiptId: { type: "integer", example: 8712 },
            receiptCounter: { type: "integer", example: 14 },
            receiptGlobalNo: { type: "integer", example: 104 },
            fiscalDayNo: { type: "integer", example: 1 },
            signature: { type: "string", example: "MEQCIGsV...==" },
            verificationUrl: { type: "string", example: "https://fdms.zimra.co.zw/verify?d=12345&r=14..." },
            qrData: { type: "string", example: "https://fdms.zimra.co.zw/verify?d=12345&r=14..." },
            qrCodeImageUrl: { type: "string", example: "https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=..." },
          },
        },
        BuyerData: {
          type: "object",
          properties: {
            buyerRegisterName: { type: "string", example: "Acme Industrial Supplies Pvt Ltd" },
            buyerTradeName: { type: "string", example: "Acme Hardware" },
            vatNumber: { type: "string", example: "10098765" },
            buyerTIN: { type: "string", example: "2009876543" },
            buyerContacts: {
              type: "object",
              properties: {
                phoneNo: { type: "string", example: "+263 77 123 4567" },
                email: { type: "string", format: "email", example: "accounts@acme.co.zw" },
              },
            },
            buyerAddress: {
              type: "object",
              properties: {
                street: { type: "string", example: "45 Simon Muzenda Street" },
                city: { type: "string", example: "Harare" },
                province: { type: "string", example: "Harare" },
              },
            },
          },
        },
        CreditDebitNoteReference: {
          type: "object",
          required: ["receiptID", "deviceID", "receiptGlobalNo", "fiscalDayNo"],
          properties: {
            receiptID: { type: "integer", example: 8712 },
            deviceID: { type: "integer", example: 12345 },
            receiptGlobalNo: { type: "integer", example: 104 },
            fiscalDayNo: { type: "integer", example: 1 },
          },
        },
        FiscalInvoiceSubmitRequest: {
          type: "object",
          required: ["currency", "lines", "payments"],
          properties: {
            deviceId: { type: "integer", example: 12345 },
            serialNumber: { type: "string", example: "MYPOS01" },
            invoiceNo: { type: "string", example: "INV-2026-0042" },
            currency: { type: "string", enum: ["USD", "ZiG", "ZAR", "EUR", "GBP"], default: "USD", example: "USD" },
            linesTaxInclusive: { type: "boolean", default: true, example: true },
            lines: {
              type: "array",
              items: { $ref: "#/components/schemas/ReceiptLine" },
            },
            payments: {
              type: "array",
              items: { $ref: "#/components/schemas/ReceiptPayment" },
            },
            buyer: { $ref: "#/components/schemas/BuyerData" },
            notes: { type: "string", example: "Counter sale" },
            mode: { type: "string", enum: ["online", "offline"], default: "online" },
            operatingMode: { type: "string", enum: ["OnlineOnly", "QueueOnFailure"], default: "QueueOnFailure" },
          },
        },
        CreditNoteSubmitRequest: {
          type: "object",
          required: ["currency", "creditDebitNote", "lines", "payments"],
          properties: {
            deviceId: { type: "integer", example: 12345 },
            serialNumber: { type: "string", example: "MYPOS01" },
            invoiceNo: { type: "string", example: "CN-2026-0012" },
            currency: { type: "string", enum: ["USD", "ZiG", "ZAR", "EUR", "GBP"], default: "USD", example: "USD" },
            creditDebitNote: { $ref: "#/components/schemas/CreditDebitNoteReference" },
            linesTaxInclusive: { type: "boolean", default: true, example: true },
            lines: {
              type: "array",
              items: { $ref: "#/components/schemas/ReceiptLine" },
            },
            payments: {
              type: "array",
              items: { $ref: "#/components/schemas/ReceiptPayment" },
            },
            buyer: { $ref: "#/components/schemas/BuyerData" },
            notes: { type: "string", example: "Refund for returned merchandise" },
            mode: { type: "string", enum: ["online", "offline"], default: "online" },
            operatingMode: { type: "string", enum: ["OnlineOnly", "QueueOnFailure"], default: "QueueOnFailure" },
          },
        },
        DebitNoteSubmitRequest: {
          type: "object",
          required: ["currency", "creditDebitNote", "lines", "payments"],
          properties: {
            deviceId: { type: "integer", example: 12345 },
            serialNumber: { type: "string", example: "MYPOS01" },
            invoiceNo: { type: "string", example: "DN-2026-0005" },
            currency: { type: "string", enum: ["USD", "ZiG", "ZAR", "EUR", "GBP"], default: "USD", example: "USD" },
            creditDebitNote: { $ref: "#/components/schemas/CreditDebitNoteReference" },
            linesTaxInclusive: { type: "boolean", default: true, example: true },
            lines: {
              type: "array",
              items: { $ref: "#/components/schemas/ReceiptLine" },
            },
            payments: {
              type: "array",
              items: { $ref: "#/components/schemas/ReceiptPayment" },
            },
            buyer: { $ref: "#/components/schemas/BuyerData" },
            notes: { type: "string", example: "Price adjustment" },
            mode: { type: "string", enum: ["online", "offline"], default: "online" },
            operatingMode: { type: "string", enum: ["OnlineOnly", "QueueOnFailure"], default: "QueueOnFailure" },
          },
        },
        AdvancePaymentSubmitRequest: {
          type: "object",
          required: ["currency", "lines", "payments"],
          properties: {
            deviceId: { type: "integer", example: 12345 },
            serialNumber: { type: "string", example: "MYPOS01" },
            invoiceNo: { type: "string", example: "ADV-2026-0089" },
            currency: { type: "string", enum: ["USD", "ZiG", "ZAR", "EUR", "GBP"], default: "USD", example: "USD" },
            linesTaxInclusive: { type: "boolean", default: true, example: true },
            lines: {
              type: "array",
              items: { $ref: "#/components/schemas/ReceiptLine" },
            },
            payments: {
              type: "array",
              items: { $ref: "#/components/schemas/ReceiptPayment" },
            },
            buyer: { $ref: "#/components/schemas/BuyerData" },
            notes: { type: "string", default: "Advance deposit" },
            mode: { type: "string", enum: ["online", "offline"], default: "online" },
            operatingMode: { type: "string", enum: ["OnlineOnly", "QueueOnFailure"], default: "QueueOnFailure" },
          },
        },
      },
    },
    paths: {
      "/api/receipts/fiscal-invoice": {
        post: {
          tags: ["Fiscal Documents"],
          summary: "Fiscal Invoice (Sale)",
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FiscalInvoiceSubmitRequest" },
              },
            },
          },
          responses: {
            200: {
              description: "Success",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ReceiptSubmitResponse" },
                },
              },
            },
            400: {
              description: "Error",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/api/receipts/credit-note": {
        post: {
          tags: ["Fiscal Documents"],
          summary: "Credit Note (Return / Refund)",
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreditNoteSubmitRequest" },
              },
            },
          },
          responses: {
            200: {
              description: "Success",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ReceiptSubmitResponse" },
                },
              },
            },
            400: {
              description: "Error",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/api/receipts/debit-note": {
        post: {
          tags: ["Fiscal Documents"],
          summary: "Debit Note (Supplementary Charge)",
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DebitNoteSubmitRequest" },
              },
            },
          },
          responses: {
            200: {
              description: "Success",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ReceiptSubmitResponse" },
                },
              },
            },
            400: {
              description: "Error",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/api/receipts/advance-payment": {
        post: {
          tags: ["Fiscal Documents"],
          summary: "Advance Payment (Deposit)",
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AdvancePaymentSubmitRequest" },
              },
            },
          },
          responses: {
            200: {
              description: "Success",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ReceiptSubmitResponse" },
                },
              },
            },
            400: {
              description: "Error",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/api/method/havanozimracloud.api.token": {
        post: {
          tags: ["Havano POS Integration"],
          summary: "Havano POS Ping & Token Verification",
          description: "Returns CSRF token and verifies gateway connectivity for Havano Desktop POS.",
          responses: {
            200: {
              description: "Token Response",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      token: { type: "string", example: "zf_live_csrf_token_ok" },
                      message: { type: "string", example: "zf_live_csrf_token_ok" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/method/havanozimracloud.api.sendinvoice": {
        post: {
          tags: ["Havano POS Integration"],
          summary: "Havano POS Invoice & Credit Note Submission",
          description: "Receives invoice payloads and items_xml from Havano Desktop POS with zero POS code adjustments.",
          requestBody: {
            required: true,
            content: {
              "application/x-www-form-urlencoded": {
                schema: {
                  type: "object",
                  properties: {
                    device_sn: { type: "string", example: "MYPOS01" },
                    invoice_flag: { type: "string", enum: ["0", "1", "3"], description: "0 for normal sale, 1 or 3 for credit note", example: "0" },
                    currency: { type: "string", example: "USD" },
                    invoice_number: { type: "string", example: "INV-1001" },
                    customer_name: { type: "string", example: "Walk-in Customer" },
                    trade_name: { type: "string", example: "Walk-in Customer" },
                    tendered: { type: "string", example: "12.50" },
                    original_invoice_no: { type: "string", example: "INV-1000" },
                    global_invoice_no: { type: "string", example: "1" },
                    items_xml: { type: "string", example: "<ITEMS><ITEM><HH>1</HH><ITEMCODE>99999999</ITEMCODE><ITEMNAME>Paracetamol</ITEMNAME><QTY>1.00</QTY><PRICE>12.50</PRICE><TOTAL>12.50</TOTAL><VAT>1.63</VAT><VATR>0.150</VATR><VNAME>VAT</VNAME></ITEM></ITEMS>" },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: "Havano POS Fiscal Response",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      message: {
                        type: "object",
                        properties: {
                          Message: { type: "string", example: "Receipt fiscalized successfully" },
                          QRcode: { type: "string", example: "https://fdmstest.zimra.co.zw/0000012345271020260000000001..." },
                          VerificationCode: { type: "string", example: "MEQCIGnohuz93gIw5q..." },
                          DeviceID: { type: "string", example: "12345" },
                          FiscalDay: { type: "string", example: "1" },
                          receiptType: { type: "string", example: "FiscalInvoice" },
                          receiptCurrency: { type: "string", example: "USD" },
                          receiptCounter: { type: "integer", example: 1 },
                          receiptGlobalNo: { type: "integer", example: 1 },
                          EFDSERIAL: { type: "string", example: "MYPOS01" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/health": {
        get: {
          tags: ["System & Health"],
          summary: "Health Check",
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", example: "ok" },
                      service: { type: "string", example: "ZIMRA FDMS Gateway" },
                      version: { type: "string", example: "0.4.1" },
                      uptime: { type: "number", example: 3600.25 },
                      timestamp: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/status": {
        get: {
          tags: ["Virtual Devices", "System & Health"],
          summary: "Fiscal Status & Telemetry",
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }, {}],
          parameters: [
            { name: "deviceId", in: "query", schema: { type: "integer" } },
            { name: "serialNumber", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: { description: "OK" },
          },
        },
      },
      "/api/stores": {
        get: {
          tags: ["Stores & Organizations"],
          summary: "List Stores",
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [
            { name: "tenantId", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: {
              description: "Stores list",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean", example: true },
                      stores: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Store" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ["Stores & Organizations"],
          summary: "Create Store",
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateStoreRequest" },
              },
            },
          },
          responses: {
            201: {
              description: "Created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean", example: true },
                      store: { $ref: "#/components/schemas/Store" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/stores/{id}": {
        get: {
          tags: ["Stores & Organizations"],
          summary: "Get Store",
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: {
              description: "Store record",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean", example: true },
                      store: { $ref: "#/components/schemas/Store" },
                    },
                  },
                },
              },
            },
            404: { description: "Not found" },
          },
        },
        put: {
          tags: ["Stores & Organizations"],
          summary: "Update Store",
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UpdateStoreRequest" },
              },
            },
          },
          responses: {
            200: {
              description: "Updated",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean", example: true },
                      store: { $ref: "#/components/schemas/Store" },
                    },
                  },
                },
              },
            },
          },
        },
        delete: {
          tags: ["Stores & Organizations"],
          summary: "Delete Store",
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Deleted" },
          },
        },
      },
      "/api/auth/register": {
        tags: ["Authentication"],
        summary: "Register Tenant",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "email", "password"],
                properties: {
                  name: { type: "string", example: "Acme Retailers" },
                  email: { type: "string", format: "email", example: "admin@acme.co.zw" },
                  password: { type: "string", format: "password", example: "AcmeSecure2026!" },
                  city: { type: "string", example: "Harare" },
                  phone: { type: "string", example: "+263 77 000 1122" },
                  address: { type: "string", example: "12 Kwame Nkrumah Ave" },
                  tin: { type: "string", example: "2009876543" },
                  vatNumber: { type: "string", example: "10098765" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Registered" },
        },
      },
      "/api/auth/login": {
        tags: ["Authentication"],
        summary: "Login",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email", example: "admin@zimra-fdms.local" },
                  password: { type: "string", format: "password", example: "Admin123" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Logged in" },
        },
      },
      "/api/auth/logout": {
        tags: ["Authentication"],
        summary: "Logout",
        responses: {
          200: { description: "Logged out" },
        },
      },
      "/api/me": {
        tags: ["Authentication"],
        summary: "Current Profile",
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        responses: {
          200: { description: "Tenant profile" },
        },
      },
      "/api/auth/regenerate-api-key": {
        tags: ["Authentication"],
        summary: "Regenerate API Key",
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        responses: {
          200: { description: "New key issued" },
        },
      },
      "/api/device/register": {
        tags: ["Virtual Devices"],
        summary: "Register Device",
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["deviceId", "serialNumber", "activationKey"],
                properties: {
                  deviceId: { type: "integer", example: 12345 },
                  serialNumber: { type: "string", example: "MYPOS01" },
                  activationKey: { type: "string", example: "ABCD1234" },
                  modelName: { type: "string", default: "Server" },
                  modelVersion: { type: "string", default: "v1" },
                  environment: { type: "string", enum: ["test", "production"], default: "test" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Device registered" },
        },
      },
      "/api/config": {
        tags: ["Virtual Devices"],
        summary: "Device Config",
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        parameters: [
          { name: "serialNumber", in: "query", schema: { type: "string" } },
        ],
        responses: {
          200: { description: "Configuration retrieved" },
        },
      },
      "/api/day/open": {
        tags: ["Fiscal Days"],
        summary: "Open Fiscal Day",
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  deviceId: { type: "integer", example: 12345 },
                  serialNumber: { type: "string", example: "MYPOS01" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Day opened" },
        },
      },
      "/api/day/close": {
        tags: ["Fiscal Days"],
        summary: "Close Fiscal Day",
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  deviceId: { type: "integer", example: 12345 },
                  serialNumber: { type: "string", example: "MYPOS01" },
                  force: { type: "boolean", default: true },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Day closed" },
        },
      },
      "/api/receipts/submit": {
        tags: ["Fiscal Receipts"],
        summary: "Submit Receipt",
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ReceiptSubmitRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "Success",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ReceiptSubmitResponse" },
              },
            },
          },
        },
      },
      "/api/receipt": {
        tags: ["Fiscal Receipts"],
        summary: "Submit Receipt (Alias)",
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ReceiptSubmitRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "Success",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ReceiptSubmitResponse" },
              },
            },
          },
        },
      },
      "/api/receipts/history": {
        tags: ["Fiscal Receipts"],
        summary: "Receipt History",
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "query", schema: { type: "string" } },
        ],
        responses: {
          200: { description: "History list" },
        },
      },
      "/api/queue/status": {
        tags: ["Offline Queue"],
        summary: "Queue Status",
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        responses: {
          200: { description: "Queue status" },
        },
      },
      "/api/queue/flush": {
        tags: ["Offline Queue"],
        summary: "Flush Queue",
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        responses: {
          200: { description: "Queue flushed" },
        },
      },
      "/api/admin/clients": {
        get: {
          tags: ["SuperAdmin"],
          summary: "Fleet Stores",
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          responses: {
            200: { description: "Fleet stores" },
          },
        },
        post: {
          tags: ["SuperAdmin", "Stores & Organizations"],
          summary: "Provision Store",
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name", "deviceId", "serialNumber", "activationKey"],
                  properties: {
                    name: { type: "string", example: "Supermarket Westgate" },
                    email: { type: "string", format: "email", example: "westgate@supermarket.co.zw" },
                    phone: { type: "string", example: "+263 77 222 3344" },
                    city: { type: "string", example: "Harare" },
                    address: { type: "string", example: "Shop 14, Westgate Mall" },
                    province: { type: "string", example: "Harare" },
                    tin: { type: "string", example: "2008889990" },
                    vatNumber: { type: "string", example: "10088899" },
                    branchName: { type: "string", example: "Westgate Branch" },
                    contactPerson: { type: "string", example: "Tendai Shumba" },
                    deviceId: { type: "integer", example: 12346 },
                    serialNumber: { type: "string", example: "POS-WST-01" },
                    activationKey: { type: "string", example: "WSTG1234" },
                    environment: { type: "string", enum: ["test", "production"], default: "test" },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: "Store provisioned" },
          },
        },
        delete: {
          tags: ["SuperAdmin"],
          summary: "Delete Store",
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [
            { name: "id", in: "query", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Deleted" },
          },
        },
      },
      "/api/admin/fiscal-days": {
        tags: ["SuperAdmin", "Fiscal Days"],
        summary: "All Fiscal Days",
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        responses: {
          200: { description: "Day statuses" },
        },
      },
      "/api/admin/fiscal-days/open-all": {
        tags: ["SuperAdmin", "Fiscal Days"],
        summary: "Batch Open Days",
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        responses: {
          200: { description: "Opened summary" },
        },
      },
      "/api/admin/fiscal-days/close-all": {
        tags: ["SuperAdmin", "Fiscal Days"],
        summary: "Batch Close Days",
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        responses: {
          200: { description: "Closed summary" },
        },
      },
    },
  };
}

/**
 * Minimalist, ultra-clean Swagger UI HTML page.
 * Collapsed by default, no bloated models or text blocks.
 */
export function getSwaggerUiHtml(specEndpoint = "/api/docs.json"): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Docs — ZIMRA FDMS</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23000080'><path d='M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5'/></svg>">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.18.2/swagger-ui.css">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #000080;
      --bg: #f8fafc;
      --font-sans: 'Inter', -apple-system, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      font-family: var(--font-sans);
      color: #0f172a;
    }
    .topbar {
      background: #0f172a;
      border-bottom: 1px solid #1e293b;
      color: #fff;
      padding: 10px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .topbar a {
      color: inherit;
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 14px;
    }
    .topbar .badge {
      background: #10b981;
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .topbar-actions {
      display: flex;
      gap: 8px;
    }
    .topbar-actions a {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.15);
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 11.5px;
      font-weight: 500;
    }
    .topbar-actions a:hover {
      background: rgba(255, 255, 255, 0.16);
    }

    /* Swagger UI minimalist layout */
    .swagger-ui .topbar { display: none !important; }
    .swagger-ui {
      max-width: 1040px;
      margin: 0 auto;
      padding: 20px 16px 80px 16px;
    }
    .swagger-ui .wrapper {
      padding: 0 !important;
      max-width: 100% !important;
    }
    .swagger-ui .info {
      margin: 16px 0 20px 0;
    }
    .swagger-ui .info .title {
      font-size: 22px;
      font-weight: 800;
      color: #0f172a;
      letter-spacing: -0.3px;
    }
    .swagger-ui .info .description {
      font-size: 13px;
      color: #64748b;
      margin-top: 4px;
    }
    .swagger-ui .info .description p { margin: 4px 0; }
    .swagger-ui .scheme-container {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 10px 16px;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
      margin-bottom: 20px;
    }
    .swagger-ui .btn.authorize {
      color: #000080;
      border-color: #000080;
      font-weight: 600;
      font-size: 12px;
      border-radius: 6px;
      padding: 5px 12px;
    }
    .swagger-ui .filter .operation-filter-input {
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 13px;
      width: 100%;
      margin-bottom: 16px;
    }
    .swagger-ui .opblock-tag {
      font-size: 16px;
      font-weight: 700;
      color: #1e293b;
      padding: 8px 0;
      border-bottom: 1px solid #e2e8f0;
      margin-bottom: 8px;
      cursor: pointer;
    }
    .swagger-ui .opblock-tag small {
      font-size: 12px;
      color: #64748b;
      font-weight: 400;
      margin-left: 6px;
    }
    .swagger-ui .opblock {
      border-radius: 6px;
      margin: 0 0 8px 0;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
    }
    .swagger-ui .opblock .opblock-summary-method {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      border-radius: 4px;
      min-width: 60px;
      text-align: center;
    }
    .swagger-ui .opblock .opblock-summary-path {
      font-family: var(--font-mono);
      font-size: 13px;
      font-weight: 600;
    }
    .swagger-ui code, .swagger-ui .prop-type {
      font-family: var(--font-mono);
    }
    /* Hide the huge schemas block at bottom to keep it completely minimalist */
    .swagger-ui section.models {
      display: none !important;
    }
  </style>
</head>
<body>
  <div class="topbar">
    <a href="/">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
      <span>ZIMRA FDMS Gateway</span>
      <span class="badge">v0.4.1</span>
    </a>
    <div class="topbar-actions">
      <a href="/">Admin Portal</a>
      <a href="${specEndpoint}" target="_blank">OpenAPI JSON</a>
    </div>
  </div>

  <div id="swagger-ui"></div>

  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.18.2/swagger-ui-bundle.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.18.2/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      const ui = SwaggerUIBundle({
        url: "${specEndpoint}",
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        layout: "StandaloneLayout",
        defaultModelsExpandDepth: -1,
        defaultModelExpandDepth: 1,
        docExpansion: "list",
        filter: true,
        showExtensions: false,
        showCommonExtensions: false,
        tryItOutEnabled: true,
        persistAuthorization: true,
        onComplete: function() {
          try {
            const hasAuth = window.ui && window.ui.getState().get('auth');
            if (!hasAuth || !hasAuth.get('ApiKeyAuth')) {
              window.ui.preauthorizeApiKey('ApiKeyAuth', 'zf_live_demo_1234567890abcdef1234567890abcdef');
            }
          } catch(e) {}
        }
      });
      window.ui = ui;
    };
  </script>
</body>
</html>
`;
}
