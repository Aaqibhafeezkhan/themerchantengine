import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { OptionalAuth, OwnerGuard, Permissions, Public, RateLimit } from '@common/decorators';
import { SESSION_COOKIE_NAME } from '../cart/cart.constants';
import { ADMIN_API_ROUTES } from '@admin-routes';
import {
  IdempotencyKey,
  IdempotencyKeyPipe,
} from '../../common/decorators/idempotency-key.decorator';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreateAdminOrderDto } from './dto/create-admin-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { EditOrderDto } from './dto/edit-order.dto';
import { CreateShipmentDto } from './dto/create-shipment.dto';
import { UpdateShipmentDto } from './dto/update-shipment.dto';
import { AddNoteDto } from './dto/add-note.dto';
import { ListOrdersStorefrontDto, ListOrdersAdminDto, TrackOrderDto } from './dto/query-orders.dto';

type AuthedRequest = { user: { id: string } };

/**
 * A request that may or may not carry a session, plus the anonymous cart
 * cookie. The guest-capable order routes take this instead of `AuthedRequest`
 * because for them `user` genuinely can be absent.
 */
type OptionalAuthRequest = {
  user?: { id?: string };
  cookies?: Record<string, string>;
};

/**
 * The anonymous cart session that identifies a guest, read straight off the
 * `HttpOnly` cookie. This is the only thing tying a guest order to the browser
 * that placed it, so it is read server-side and never accepted from the body.
 */
function guestSessionOf(req: OptionalAuthRequest): string | undefined {
  return req.cookies?.[SESSION_COOKIE_NAME];
}

// ═══════════════════════════════════════════════════════════════════════════════
// STOREFRONT CONTROLLER
// ═══════════════════════════════════════════════════════════════════════════════

@ApiTags('orders')
@Controller('v1/orders')
export class OrdersStorefrontController {
  constructor(private readonly orders: OrdersService) {}

  // ── POST /v1/orders ──────────────────────────────────────────────────────

  /**
   * Create an order, for a signed-in customer or a guest.
   *
   * `@OptionalAuth()` replaces `@OwnerGuard()` here, and the swap is the point
   * rather than a detail. `OwnerGuardGuard` is a real global guard, not inert
   * metadata: on a handler carrying `@OwnerGuard()` it throws
   * `OWNER_GUARD_USER_MISSING` whenever `req.user.id` is absent. Adding
   * `@OptionalAuth()` alongside it would let the session guard through and then
   * reject every anonymous request one guard later. The cart controller already
   * records this precedent: only its authenticated-only route opts into
   * `@OwnerGuard()`, because the rest serve anonymous callers.
   *
   * Ownership does not go unenforced. It moves to the service, which is where
   * §3.3 requires it anyway, and which is the only layer that can tell an
   * account order from a guest one.
   */
  @Post()
  @OptionalAuth()
  @RateLimit.StorefrontWrite()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create order (authenticated customer or guest)' })
  @ApiResponse({ status: 201, description: 'Order created' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 403, description: 'Guest checkout disabled' })
  createOrder(
    @Body() dto: CreateOrderDto,
    @Req() req: OptionalAuthRequest,
    @IdempotencyKey(IdempotencyKeyPipe) idempotencyKey: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return this.orders.createOrder(
      dto,
      req.user?.id,
      idempotencyKey,
      acceptLanguage,
      guestSessionOf(req),
    );
  }

  // ── GET /v1/orders ───────────────────────────────────────────────────────

  @Get()
  @OwnerGuard()
  @RateLimit.StorefrontRead()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List orders' })
  @ApiResponse({ status: 200, description: 'Orders retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  listOrders(@Req() req: AuthedRequest, @Query() query: ListOrdersStorefrontDto) {
    return this.orders.listStorefront(req.user.id, query);
  }

  // ── POST /v1/orders/track ────────────────────────────────────────────────

  /**
   * Look an order up by its number plus the email on file.
   *
   * A POST with a body rather than the `GET :orderNumber/track?email=` it
   * replaces (finding K10). The email address is the shared secret that
   * authorises this read, and a query string is the wrong place for one: it
   * lands in the reverse-proxy access log, in the `Referer` of anything the
   * page loads next, and in the browser's own history. A body carries it in
   * none of those.
   *
   * `@HttpCode(200)` because this is a lookup, not a creation, whatever the
   * verb says.
   *
   * Declared before the `:id` route below on purpose: Nest matches in
   * declaration order, and a later `track` would be swallowed as an order id.
   */
  @Post('track')
  @Public()
  @RateLimit.StorefrontRead()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Track an order by number and email' })
  @ApiResponse({ status: 200, description: 'Order tracking data' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  trackOrder(@Body() dto: TrackOrderDto) {
    return this.orders.trackOrder({ orderNumber: dto.orderNumber, email: dto.email });
  }

  // ── POST /v1/orders/track/payment ────────────────────────────────────────

  /**
   * Pay again for a guest order from the track page. The order number plus the
   * email on file prove ownership when the cart session is gone. Declared
   * before `:id` for the same reason as `track`.
   */
  @Post('track/payment')
  @Public()
  @RateLimit.StorefrontWrite()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry the payment of a tracked order' })
  @ApiResponse({ status: 200, description: 'New payment action' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Order payment is not retryable' })
  retryTrackedPayment(
    @Body() dto: TrackOrderDto,
    @IdempotencyKey(IdempotencyKeyPipe) _idempotencyKey: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return this.orders.retryTrackedPayment(
      { orderNumber: dto.orderNumber, email: dto.email },
      acceptLanguage,
    );
  }

  // ── GET /v1/orders/:id ───────────────────────────────────────────────────

  /**
   * One order. Same `@OwnerGuard()` to `@OptionalAuth()` swap as the create
   * above, for the same reason and with the same service-layer enforcement:
   * an account order matches on `userId`, a guest order on the anonymous cart
   * cookie it recorded, and neither can be reached by the other's caller.
   *
   * Without this the confirmation page showed a guest a login wall one second
   * after they paid.
   */
  @Get(':id')
  @OptionalAuth()
  @RateLimit.StorefrontRead()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get order by ID (owner or the guest who placed it)' })
  @ApiResponse({ status: 200, description: 'Order retrieved' })
  @ApiResponse({ status: 403, description: "Not the caller's order" })
  @ApiResponse({ status: 404, description: 'Order not found' })
  findOne(@Param('id') id: string, @Req() req: OptionalAuthRequest) {
    return this.orders.findOneStorefront(id, req.user?.id, guestSessionOf(req));
  }

  // ── GET /v1/orders/:id/invoice ───────────────────────────────────────────

  @Get(':id/invoice')
  @OwnerGuard()
  @RateLimit.StorefrontRead()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get order invoice' })
  @ApiResponse({ status: 200, description: 'Invoice retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  getInvoice(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.orders.getInvoice(id, req.user.id);
  }

  // ── GET /v1/orders/:id/invoice/pdf ───────────────────────────────────────
  // Streams the branded PDF (owner-scoped, re-checked per byte). The storefront
  // navigates here via `window.location.href = invoice.downloadUrl`; the
  // same-origin proxy forwards it with the session cookie (SameSite=Lax,
  // same registrable domain). Cache-Control stays `no-store` (PII) via the
  // global §3.15-A hardening; @Res bypasses the JSON envelope (CSV-export pattern).

  @Get(':id/invoice/pdf')
  @OwnerGuard()
  @RateLimit.StorefrontRead()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Download order invoice as a branded PDF' })
  @ApiResponse({ status: 200, description: 'PDF stream' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Order does not belong to the caller' })
  @ApiResponse({ status: 404, description: 'Order not found or invoice not ready' })
  async getInvoicePdf(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
    @Res() res: Response,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<void> {
    const { buffer, invoiceNumber } = await this.orders.getInvoicePdf(id, {
      userId: req.user.id,
      acceptLanguage,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${invoiceNumber}.pdf"`);
    res.send(buffer);
  }

  // ── POST /v1/orders/:id/cancel ───────────────────────────────────────────

  @Post(':id/cancel')
  @OwnerGuard()
  @RateLimit.StorefrontWrite()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel order' })
  @ApiResponse({ status: 200, description: 'Order cancelled' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Order cannot be cancelled' })
  cancelOrder(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.orders.cancelOrder(id, req.user.id);
  }

  // ── POST /v1/orders/:id/payment ──────────────────────────────────────────

  /**
   * Take a new payment attempt on an order whose payment is still pending or
   * failed. Guest-capable like `findOne`: the service matches the account or
   * the anonymous cart cookie, so `@OwnerGuard()` stays off for the same reason
   * as on `createOrder`. Returns the fresh `paymentAction` for the storefront
   * to run.
   */
  @Post(':id/payment')
  @OptionalAuth()
  @RateLimit.StorefrontWrite()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry the payment of an order' })
  @ApiResponse({ status: 200, description: 'New payment action' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Order payment is not retryable' })
  retryPayment(
    @Param('id') id: string,
    @Req() req: OptionalAuthRequest,
    @IdempotencyKey(IdempotencyKeyPipe) _idempotencyKey: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return this.orders.retryPayment(id, {
      userId: req.user?.id,
      sessionId: guestSessionOf(req),
      acceptLanguage,
    });
  }

  /**
   * Asks the provider for the live payment status after the customer returns
   * from it, so the page does not depend on the webhook arriving first.
   */
  @Post(':id/payment/confirm')
  @OptionalAuth()
  @RateLimit.StorefrontWrite()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm the payment status of an order with the provider' })
  @ApiResponse({ status: 200, description: 'Current payment status' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  confirmPayment(
    @Param('id') id: string,
    @Req() req: OptionalAuthRequest,
    // The pipe enforces the header; the value itself is not needed.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    @IdempotencyKey(IdempotencyKeyPipe) _idempotencyKey: string,
  ) {
    return this.orders.confirmPayment(id, { userId: req.user?.id, sessionId: guestSessionOf(req) });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN CONTROLLER
// ═══════════════════════════════════════════════════════════════════════════════

@ApiTags('orders')
@Controller(ADMIN_API_ROUTES.orders.base)
export class OrdersAdminController {
  constructor(private readonly orders: OrdersService) {}

  // ── POST /v1/admin/orders ─────────────────────────────────────────────────

  @Post()
  @Permissions('orders:create')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create order (admin manual)' })
  @ApiResponse({ status: 201, description: 'Order created' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  createOrder(
    @Body() dto: CreateAdminOrderDto,
    @Req() req: AuthedRequest,
    @IdempotencyKey(IdempotencyKeyPipe) idempotencyKey: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return this.orders.createManualOrder(dto, req.user.id, idempotencyKey, acceptLanguage);
  }

  // ── GET /v1/admin/orders/stats ───────────────────────────────────────────

  @Get(ADMIN_API_ROUTES.orders.stats)
  @Permissions('orders:view')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get orders statistics' })
  @ApiResponse({ status: 200, description: 'Statistics retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  getStats() {
    return this.orders.getStats();
  }

  // ── GET /v1/admin/orders/export ──────────────────────────────────────────

  @Get(ADMIN_API_ROUTES.orders.export)
  @Permissions('orders:view')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Export orders to CSV' })
  @ApiResponse({ status: 200, description: 'CSV file' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async exportCsv(@Query() query: ListOrdersAdminDto, @Res() res: Response) {
    const csv = await this.orders.exportCsv(query);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.send(csv);
  }

  // ── GET /v1/admin/orders ─────────────────────────────────────────────────

  @Get()
  @Permissions('orders:view')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List orders (admin)' })
  @ApiResponse({ status: 200, description: 'Orders retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  listOrders(@Query() query: ListOrdersAdminDto) {
    return this.orders.listAdmin(query);
  }

  // ── GET /v1/admin/orders/:id ─────────────────────────────────────────────

  @Get(ADMIN_API_ROUTES.orders.byId)
  @Permissions('orders:view')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get order by ID (admin)' })
  @ApiResponse({ status: 200, description: 'Order retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  findOne(@Param('id') id: string) {
    return this.orders.findOneAdmin(id);
  }

  // ── GET /v1/admin/orders/:id/invoice ─────────────────────────────────────

  @Get(ADMIN_API_ROUTES.orders.invoice)
  @Permissions('orders:view')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get order invoice (admin)' })
  @ApiResponse({ status: 200, description: 'Invoice retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  getInvoice(@Param('id') id: string) {
    return this.orders.getInvoice(id);
  }

  // ── GET /v1/admin/orders/:id/invoice/pdf ─────────────────────────────────

  @Get(ADMIN_API_ROUTES.orders.invoicePdf)
  @Permissions('orders:view')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Download order invoice as a branded PDF (admin)' })
  @ApiResponse({ status: 200, description: 'PDF stream' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found or invoice not ready' })
  async getInvoicePdf(
    @Param('id') id: string,
    @Res() res: Response,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<void> {
    const { buffer, invoiceNumber } = await this.orders.getInvoicePdf(id, { acceptLanguage });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${invoiceNumber}.pdf"`);
    res.send(buffer);
  }

  // ── PATCH /v1/admin/orders/:id/status ────────────────────────────────────

  @Patch(ADMIN_API_ROUTES.orders.status)
  @Permissions('orders:update')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update order status' })
  @ApiResponse({ status: 200, description: 'Status updated' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
    @Req() req: AuthedRequest,
  ) {
    return this.orders.updateStatus(id, dto.status, req.user.id);
  }

  // ── POST /v1/admin/orders/:id/payment/capture ────────────────────────────

  @Post(ADMIN_API_ROUTES.orders.paymentCapture)
  @Permissions('payments:manage')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Capture the order payment through its provider' })
  @ApiResponse({ status: 200, description: 'Payment captured' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Transition not allowed or no payment session' })
  capturePayment(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
    @IdempotencyKey(IdempotencyKeyPipe) idempotencyKey: string,
  ) {
    return this.orders.capturePayment(id, req.user.id, idempotencyKey);
  }

  // ── POST /v1/admin/orders/:id/payment/refund ─────────────────────────────

  @Post(ADMIN_API_ROUTES.orders.paymentRefund)
  @Permissions('payments:manage')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refund the full order payment through its provider' })
  @ApiResponse({ status: 200, description: 'Payment refunded' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Transition not allowed or no payment session' })
  refundPayment(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
    @IdempotencyKey(IdempotencyKeyPipe) idempotencyKey: string,
  ) {
    return this.orders.refundPayment(id, req.user.id, idempotencyKey);
  }

  // ── POST /v1/admin/orders/:id/payment/cancel ─────────────────────────────

  @Post(ADMIN_API_ROUTES.orders.paymentCancel)
  @Permissions('payments:manage')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel the order payment through its provider' })
  @ApiResponse({ status: 200, description: 'Payment cancelled' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Transition not allowed or no payment session' })
  cancelPayment(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
    @IdempotencyKey(IdempotencyKeyPipe) idempotencyKey: string,
  ) {
    return this.orders.cancelPayment(id, req.user.id, idempotencyKey);
  }

  // ── PATCH /v1/admin/orders/:id ───────────────────────────────────────────

  @Patch(ADMIN_API_ROUTES.orders.byId)
  @Permissions('orders:update')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Edit order' })
  @ApiResponse({ status: 200, description: 'Order updated' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  editOrder(
    @Param('id') id: string,
    @Body() dto: EditOrderDto,
    @Req() req: AuthedRequest,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return this.orders.editOrder(id, dto, req.user.id, acceptLanguage);
  }

  // ── POST /v1/admin/orders/:id/shipments ──────────────────────────────────

  @Post(ADMIN_API_ROUTES.orders.shipments)
  @Permissions('orders:update')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create shipment' })
  @ApiResponse({ status: 201, description: 'Shipment created' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  createShipment(
    @Param('id') id: string,
    @Body() dto: CreateShipmentDto,
    @Req() req: AuthedRequest,
  ) {
    return this.orders.createShipment(id, dto, req.user.id);
  }

  // ── PATCH /v1/admin/orders/:id/shipments/:sid ────────────────────────────

  @Patch(ADMIN_API_ROUTES.orders.shipmentById)
  @Permissions('orders:update')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update shipment' })
  @ApiResponse({ status: 200, description: 'Shipment updated' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Shipment not found' })
  updateShipment(
    @Param('id') id: string,
    @Param('sid') sid: string,
    @Body() dto: UpdateShipmentDto,
    @Req() req: AuthedRequest,
  ) {
    return this.orders.updateShipment(id, sid, dto, req.user.id);
  }

  // ── POST /v1/admin/orders/:id/notes ──────────────────────────────────────

  @Post(ADMIN_API_ROUTES.orders.notes)
  @Permissions('orders:update')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add order note' })
  @ApiResponse({ status: 200, description: 'Note added' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  addNote(@Param('id') id: string, @Body() dto: AddNoteDto, @Req() req: AuthedRequest) {
    return this.orders.addNote(id, dto.note, req.user.id);
  }
}
