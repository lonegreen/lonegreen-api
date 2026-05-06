const PDFDocument = require("pdfkit");

function text(value, fallback = "-") {
  const clean = value === null || value === undefined ? "" : String(value);
  return clean.trim() || fallback;
}

function money(value) {
  const amount = Number(value || 0);
  return `$${amount.toFixed(2)}`;
}

function dateText(value) {
  if (!value) {
    return "-";
  }

  return String(value).split("T")[0] || "-";
}

function parseLineItems(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value) {
    return [];
  }

  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toTitleWords(value) {
  return String(value || "")
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function serviceSummaryLines(invoice) {
  const serviceType = toTitleWords(invoice.job_service || invoice.service || "Service") || "Service";
  const serviceDate = invoice.job_date ? dateText(invoice.job_date) : "-";
  const workType = invoice.source_subscription_id ? "Subscription Service" : "Field Service";
  return [
    `Service Type: ${serviceType}`,
    `Service Date: ${serviceDate}`,
    `Work Type: ${workType}`
  ];
}

function collectPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

function addHeader(doc, title, company = {}, meta = {}) {
  const topY = doc.y;
  const companyName = text(company.name, "LoneGreen");
  const compactCompanyName = companyName.length > 64 ? `${companyName.slice(0, 61)}...` : companyName;
  doc.fontSize(12).fillColor("#1f5c3a").text(compactCompanyName, 50, topY, { width: 300 });
  doc.fontSize(8).fillColor("#4b6358");
  const lines = [company.phone, company.email, company.website, company.address].filter(Boolean);
  lines.forEach((line, idx) => {
    doc.text(text(line), 50, topY + 15 + (idx * 9), { width: 310 });
  });

  doc.fontSize(19).fillColor("#173327").text(title, 350, topY, { width: 210, align: "right" });
  if (meta.status) {
    doc.roundedRect(462, topY + 25, 98, 16, 8).fillAndStroke("#eef2f0", "#dbe7df");
    doc.fillColor("#173327").fontSize(8.5).text(text(meta.status, "UNPAID"), 462, topY + 29, { width: 98, align: "center" });
  }
  doc.moveTo(50, topY + 60).lineTo(562, topY + 60).strokeColor("#dbe7df").stroke();
  doc.y = topY + 66;
}

function addKeyValue(doc, label, value) {
  doc.fontSize(9).fillColor("#6b8278").text(label.toUpperCase(), { continued: true });
  doc.fillColor("#173327").text(`  ${text(value)}`);
}

function addLineItems(doc, items, fallbackDescription, fallbackAmount, serviceName, fallbackNotes) {
  doc.moveDown(0.35);
  doc.fontSize(10.5).fillColor("#173327").text("Services");
  doc.moveDown(0.2);

  const safeItems = items.length ? items : [{
    description: fallbackDescription || "Service",
    quantity: 1,
    price: Number(fallbackAmount || 0),
    amount: Number(fallbackAmount || 0)
  }];

  doc.rect(50, doc.y - 2, 512, 16).fill("#f7faf8");
  doc.fontSize(8.5).fillColor("#6b8278");
  doc.text("Service", 56, doc.y + 2, { continued: true, width: 90 });
  doc.text("Description", 146, doc.y + 2, { continued: true, width: 180 });
  doc.text("Qty", 336, doc.y + 2, { continued: true, width: 50, align: "right" });
  doc.text("Unit Price", 392, doc.y + 2, { continued: true, width: 75, align: "right" });
  doc.text("Total", 472, doc.y + 2, { width: 84, align: "right" });
  doc.moveDown(0.2);
  doc.strokeColor("#dbe7df").moveTo(50, doc.y).lineTo(562, doc.y).stroke();
  doc.moveDown(0.2);

  for (const item of safeItems) {
    const quantity = Number(item.quantity || 1);
    const price = Number(item.price || 0);
    const amount = Number(item.amount !== undefined ? item.amount : quantity * price);
    const primaryService = toTitleWords(text(serviceName || fallbackDescription, "Service"));
    const rawDescription = text(item.description, "Service");
    const useFallbackDescription = rawDescription.toLowerCase() === primaryService.toLowerCase();
    const finalDescription = useFallbackDescription
      ? text(fallbackNotes, "Service completed as requested")
      : rawDescription;

    doc.fontSize(9.5).fillColor("#173327");
    const y = doc.y;
    doc.text(primaryService, 56, y, { width: 90 });
    doc.text(finalDescription, 146, y, { width: 180 });
    doc.text(String(quantity), 336, y, { width: 50, align: "right" });
    doc.text(money(price), 392, y, { width: 75, align: "right" });
    doc.text(money(amount), 472, y, { width: 84, align: "right" });
    doc.moveDown(0.35);
  }
  return { endY: doc.y, rowCount: safeItems.length };
}

function addPaymentSectionAt(doc, invoice, invoiceNumber, x, y, width) {
  const instructionText = text(invoice.payment_instructions || invoice.invoice_branding?.payment_instructions || "", "");
  const zelleName = text(invoice.zelle_name || invoice.invoice_branding?.zelle_name || "", "");
  const zelleContact = text(invoice.zelle_contact || invoice.invoice_branding?.zelle_contact || "", "");

  const companyPayee = text(
    invoice.invoice_branding?.display_name || invoice.branded_company_name || invoice.company_name,
    "Company"
  );
  const zelleLine = zelleContact || zelleName || "Contact company";
  doc.fontSize(8.5).fillColor("#6b8278").text("Payment Methods", x, y, { width });
  doc.fontSize(8.2).fillColor("#173327").text(`Zelle: ${zelleLine}`, x, y + 9, { width });
  doc.text(`Check: Payable to ${companyPayee}`, x, y + 17, { width });
  doc.text("ACH: Contact company", x, y + 25, { width });
  doc.text("Cash: Accepted", x, y + 33, { width });
  doc.fontSize(7.8).fillColor("#4b6358").text(`Memo: Invoice ${text(invoiceNumber, `#${invoice.id}`)}`, x, y + 41, { width });
  if (instructionText) {
    const compactInstruction = instructionText.length > 90 ? `${instructionText.slice(0, 87)}...` : instructionText;
    doc.fontSize(7.8).fillColor("#4b6358").text(compactInstruction, x, y + 49, { width });
    return 60;
  }
  return 51;
}

function drawTotalsAt(doc, invoice, x, y, width) {
  const subtotal = Number(invoice.subtotal != null ? invoice.subtotal : invoice.amount || 0);
  const taxAmount = Number(invoice.tax_amount != null ? invoice.tax_amount : invoice.tax || 0);
  const rows = [
    ["Subtotal", money(subtotal)],
    ...(taxAmount > 0 ? [["Tax", money(taxAmount)]] : []),
    ["Paid", money(invoice.paid_amount)],
    ["Remaining", money(invoice.remaining_balance)],
    ["Total", money(invoice.amount)]
  ];

  doc.fontSize(8.5).fillColor("#6b8278").text("Totals", x, y, { width, align: "right" });
  let rowY = y + 10;
  rows.forEach((row, idx) => {
    const isTotal = idx === rows.length - 1;
    doc.fontSize(isTotal ? 9 : 8.5).fillColor(isTotal ? "#173327" : "#4b6358").text(row[0], x, rowY, { width: width - 80, align: "right" });
    doc.fontSize(isTotal ? 9.5 : 8.5).fillColor("#173327").text(row[1], x + width - 76, rowY, { width: 76, align: "right" });
    rowY += 10;
  });
  return rowY - y;
}

function getTotalsSectionHeight(invoice) {
  const taxAmount = Number(invoice.tax_amount != null ? invoice.tax_amount : invoice.tax || 0);
  const rowsCount = 1 + (taxAmount > 0 ? 1 : 0) + 3 + 1; // subtotal + tax? + paid/remaining + total
  return 10 + (rowsCount * 10);
}

function compactStatus(invoice) {
  const status = String(invoice.status || "unpaid").toLowerCase();
  const paid = Number(invoice.paid_amount || 0);
  const remaining = Number(invoice.remaining_balance || 0);
  if (!["paid", "cancelled", "overdue"].includes(status) && paid > 0 && remaining > 0) {
    return "PARTIAL";
  }
  return text(status.toUpperCase(), "UNPAID");
}

async function generateInvoicePdf(invoice) {
  const doc = new PDFDocument({ margin: 28, size: "LETTER" });
  const branding = invoice.invoice_branding || {};
  const company = {
    name: branding.display_name || invoice.branded_company_name || invoice.company_name,
    phone: branding.phone || invoice.branded_company_phone || invoice.company_phone,
    email: branding.email || invoice.branded_company_email || invoice.company_email,
    website: branding.website || invoice.branded_company_website || "",
    address: branding.address || invoice.branded_company_address || invoice.company_address
  };

  const invoiceNumber = text(invoice.invoice_number, `#${invoice.id}`);
  addHeader(doc, "INVOICE", company, { status: compactStatus(invoice) });

  const detailTop = doc.y;
  const rightWidth = 190;
  const rightX = 370;
  doc.fontSize(8).fillColor("#6b8278").text("INVOICE DETAILS", rightX, detailTop, { width: rightWidth, align: "right" });
  doc.fontSize(8.5).fillColor("#173327").text(`Invoice #: ${invoiceNumber}`, rightX, detailTop + 9, { width: rightWidth, align: "right" });
  doc.text(`Issue Date: ${dateText(invoice.issued_date)}`, rightX, detailTop + 18, { width: rightWidth, align: "right" });
  doc.text(`Due Date: ${dateText(invoice.due_date)}`, rightX, detailTop + 27, { width: rightWidth, align: "right" });
  doc.text(`Balance: ${money(invoice.remaining_balance)}`, rightX, detailTop + 36, { width: rightWidth, align: "right" });

  const row1Y = detailTop + 2;
  doc.roundedRect(50, row1Y, 246, 44, 4).strokeColor("#dbe7df").stroke();
  doc.roundedRect(316, row1Y, 246, 44, 4).strokeColor("#dbe7df").stroke();
  doc.fontSize(8).fillColor("#6b8278").text("BILL TO", 56, row1Y + 4, { width: 236 });
  const billToLines = [
    invoice.client_name || invoice.customer_name || "Client",
    invoice.client_phone || "",
    invoice.client_address || ""
  ].filter(Boolean);
  billToLines.forEach((line, idx) => {
    doc.fontSize(8.2).fillColor("#173327").text(text(line), 56, row1Y + 14 + (idx * 9), { width: 236 });
  });
  doc.fontSize(8).fillColor("#6b8278").text("SERVICE SUMMARY", 322, row1Y + 4, { width: 236 });
  serviceSummaryLines(invoice).forEach((line, idx) => {
    doc.fontSize(8.2).fillColor("#173327").text(line, 322, row1Y + 14 + (idx * 9), { width: 236 });
  });

  const row2Y = row1Y + 48;
  doc.roundedRect(50, row2Y, 246, 42, 4).strokeColor("#dbe7df").stroke();
  doc.roundedRect(316, row2Y, 246, 42, 4).strokeColor("#dbe7df").stroke();
  doc.fontSize(8).fillColor("#6b8278").text("SERVICE ADDRESS", 56, row2Y + 4, { width: 236 });
  const addrLine = [invoice.client_address, invoice.client_zip].filter(Boolean).join(", ") || "-";
  doc.fontSize(8.2).fillColor("#173327").text(addrLine, 56, row2Y + 16, { width: 236 });
  addPaymentSectionAt(doc, invoice, invoiceNumber, 322, row2Y + 4, 236);

  doc.y = row2Y + 45;

  const lineLayout = addLineItems(
    doc,
    parseLineItems(invoice.line_items),
    invoice.job_service || invoice.service || "Service",
    invoice.amount,
    invoice.job_service || invoice.service || "Service",
    invoice.notes
  );

  const pageBottom = doc.page.height - doc.page.margins.bottom;
  const bottomStartBase = (lineLayout && lineLayout.endY ? lineLayout.endY : doc.y) + 2;
  const leftWidth = 300;
  const totalsX = 368;
  const totalsWidth = 192;

  // Measure heights first so payment + totals stay together.
  const blockHeight = getTotalsSectionHeight(invoice);
  const footerReserve = 14;
  let bottomY = bottomStartBase;

  if (bottomY + blockHeight + footerReserve > pageBottom) {
    if ((lineLayout && lineLayout.rowCount <= 10)) {
      // For simple invoices, pull the entire bottom block up so it stays on page 1.
      bottomY = Math.max(doc.page.margins.top + 86, pageBottom - (blockHeight + footerReserve));
    } else {
      doc.addPage();
      bottomY = doc.page.margins.top + 14;
    }
  }

  const totalsHeight = drawTotalsAt(doc, invoice, totalsX, bottomY, totalsWidth);
  doc.y = bottomY + totalsHeight + 2;

  if (invoice.notes && doc.y + 24 < pageBottom) {
    doc.moveDown(0.1);
    doc.fontSize(8).fillColor("#6b8278").text("Notes");
    doc.fontSize(8.5).fillColor("#4b6358").text(text(invoice.notes), { lineGap: 0 });
  }

  doc.moveDown(0.1);
  const footerWebsite = branding.website || invoice.branded_company_website || "";
  const footerMessage = [text(branding.footer || invoice.invoice_footer || "", ""), footerWebsite, `Invoice reference: ${invoiceNumber}`]
    .filter(Boolean)
    .join("  •  ");
  // Prevent a tiny footer-only overflow page in compact invoices.
  if (doc.y + 10 < pageBottom) {
    doc.fontSize(7.8).fillColor("#4b6358").text(
      footerMessage || `Thank you for your business. Invoice reference: ${invoiceNumber}`,
      50,
      doc.y,
      { width: 512, align: "center", lineBreak: false }
    );
  }
  doc.info = doc.info || {};
  doc.info.Title = `LoneGreen ${invoiceNumber}`;
  return collectPdf(doc);
}

async function generateEstimatePdf(estimate, company = {}) {
  const doc = new PDFDocument({ margin: 50, size: "LETTER" });

  addHeader(doc, `Estimate #${text(estimate.id)}`, company);

  doc.fontSize(12).fillColor("#173327").text("Customer");
  doc.moveDown(0.3);
  addKeyValue(doc, "Name", estimate.customer_name || estimate.client_name);
  addKeyValue(doc, "Phone", estimate.phone);
  addKeyValue(doc, "Address", estimate.address);
  addKeyValue(doc, "Service", estimate.service);
  addKeyValue(doc, "Visit Date", dateText(estimate.visit_date));
  addKeyValue(doc, "Status", estimate.status);

  addLineItems(doc, [], estimate.service || "Service", estimate.quoted_price);

  doc.moveDown(0.8);
  doc.fontSize(12).fillColor("#173327").text(`Estimate Total: ${money(estimate.quoted_price)}`, {
    align: "right"
  });

  if (estimate.notes) {
    doc.moveDown(1);
    doc.fontSize(12).fillColor("#173327").text("Notes");
    doc.fontSize(10).fillColor("#4b6358").text(text(estimate.notes));
  }

  return collectPdf(doc);
}

module.exports = {
  generateInvoicePdf,
  generateEstimatePdf
};
