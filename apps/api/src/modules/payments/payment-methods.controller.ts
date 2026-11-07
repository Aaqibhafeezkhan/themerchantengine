import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Permissions, RateLimit } from '@common/decorators';
import { ADMIN_API_ROUTES } from '@admin-routes';
import { CreatePaymentMethodDto } from './dto/create-payment-method.dto';
import { ListPaymentMethodsDto } from './dto/query-payment-methods.dto';
import { ReorderPaymentMethodsDto } from './dto/reorder-payment-methods.dto';
import { UpdatePaymentMethodDto } from './dto/update-payment-method.dto';
import { PaymentMethodsService } from './payment-methods.service';

@ApiTags('payment-methods')
@Controller(ADMIN_API_ROUTES.paymentMethods.base)
export class PaymentMethodsController {
  constructor(private readonly service: PaymentMethodsService) {}

  @Get(ADMIN_API_ROUTES.paymentMethods.list)
  @Permissions('payment_methods:view')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List payment methods' })
  @ApiResponse({ status: 200, description: 'Methods retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  list(@Query() query: ListPaymentMethodsDto) {
    return this.service.list(query);
  }

  /** Before the `:id` route so `payment-providers` is its own path. */
  @Get(ADMIN_API_ROUTES.paymentMethods.providers)
  @Permissions('payment_methods:view')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List registered payment providers with their config schema' })
  @ApiResponse({ status: 200, description: 'Providers retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  providers() {
    return this.service.providerCatalogue();
  }

  /** Reorder before the `:id` route so the segment doesn't shadow. */
  @Post(ADMIN_API_ROUTES.paymentMethods.reorder)
  @Permissions('payment_methods:update')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Reorder payment methods' })
  @ApiResponse({ status: 204, description: 'Reordered' })
  @ApiResponse({ status: 400, description: 'Invalid ids payload' })
  @ApiResponse({ status: 404, description: 'One or more ids unknown' })
  async reorder(@Body() dto: ReorderPaymentMethodsDto): Promise<void> {
    await this.service.reorder(dto.ids);
  }

  @Get(ADMIN_API_ROUTES.paymentMethods.byId)
  @Permissions('payment_methods:view')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get payment method' })
  @ApiResponse({ status: 200, description: 'Method retrieved' })
  @ApiResponse({ status: 404, description: 'Not found' })
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post(ADMIN_API_ROUTES.paymentMethods.list)
  @Permissions('payment_methods:create')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create payment method' })
  @ApiResponse({ status: 201, description: 'Created' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 409, description: 'Code already in use' })
  create(@Body() dto: CreatePaymentMethodDto) {
    return this.service.create(dto);
  }

  @Patch(ADMIN_API_ROUTES.paymentMethods.byId)
  @Permissions('payment_methods:update')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update payment method' })
  @ApiResponse({ status: 200, description: 'Updated' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 404, description: 'Not found' })
  update(@Param('id') id: string, @Body() dto: UpdatePaymentMethodDto) {
    return this.service.update(id, dto);
  }

  @Delete(ADMIN_API_ROUTES.paymentMethods.byId)
  @Permissions('payment_methods:delete')
  @RateLimit.Admin()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete payment method' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.service.remove(id);
  }
}
