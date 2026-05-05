const express = require("express");
const clientsRoutes = require("./clients");
const jobsRoutes = require("./jobs");
const subscriptionsRoutes = require("./subscriptions");
const estimatesRoutes = require("./estimates");
const workersRoutes = require("./workers");
const calendarRoutes = require("./calendar");
const zipGroupsRoutes = require("./zipGroups");
const notificationsRoutes = require("./notifications");

const router = express.Router();

router.use(clientsRoutes);
router.use(jobsRoutes);
router.use(subscriptionsRoutes);
router.use(estimatesRoutes);
router.use(workersRoutes);
router.use(calendarRoutes);
router.use(zipGroupsRoutes);
router.use(notificationsRoutes);

module.exports = router;
