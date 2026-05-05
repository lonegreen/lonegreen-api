const express = require("express");
const leadsRoutes = require("./leads");
const estimatesRoutes = require("./estimates");
const jobsRoutes = require("./jobs");
const clientsRoutes = require("./clients");
const invoicesRoutes = require("./invoices");
const paymentsRoutes = require("./payments");

const router = express.Router();

router.use(leadsRoutes);
router.use(estimatesRoutes);
router.use(jobsRoutes);
router.use(clientsRoutes);
router.use(invoicesRoutes);
router.use(paymentsRoutes);

module.exports = router;
