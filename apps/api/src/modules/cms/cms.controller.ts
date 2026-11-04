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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permissions, Public, RateLimit } from '@common/decorators';
import { ADMIN_API_ROUTES } from '@admin-routes';
import { CmsService } from './cms.service';
import { CreatePageAdminDto, ListPagesAdminDto, UpdatePageAdminDto } from './dto';

// ── Storefront (public) ───────────────────────────────────────────────────────

@ApiTags('cms')
@Controller('v1/pages')
export class CmsStorefrontController {
  constructor(private readonly service: CmsService) {}

  /**
   * Returns all published pages, ordered by sortOrder.
   */
  @Get()
  @Public()
  @RateLimit.StorefrontRead()
  @ApiOperation({ summary: 'List published CMS pages' })
  getPages() {
    return this.service.getPages();
  }

  /**
   * Returns a published page by slug.
   */
  @Get('*slug')
  @Public()
  @RateLimit.StorefrontRead()
  @ApiOperation({ summary: 'Get a published CMS page by slug' })
  getPageBySlug(@Param('slug') slug: string | string[]) {
    // path-to-regexp v8 hands a wildcard back as an array of segments.
    const path = Array.isArray(slug) ? slug.join('/') : slug;
    return this.service.getPageBySlug(`/${path}`);
  }
}

// ── Admin ─────────────────────────────────────────────────────────────────────

@Controller(ADMIN_API_ROUTES.cms.base)
export class CmsAdminController {
  constructor(private readonly service: CmsService) {}

  /**
   * List all pages (including unpublished).
   */
  @Get()
  @Permissions('cms:view')
  @RateLimit.Admin()
  @ApiOperation({ summary: 'List all CMS pages including unpublished' })
  adminGetPages(@Query() dto: ListPagesAdminDto) {
    return this.service.adminGetPages(dto.page, dto.pageSize);
  }

  /**
   * Create a new CMS page.
   */
  @Post()
  @Permissions('cms:create')
  @RateLimit.Admin()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create new CMS page' })
  createPage(@Body() dto: CreatePageAdminDto) {
    return this.service.createPage(dto);
  }

  /**
   * Update a CMS page.
   */
  @Patch(ADMIN_API_ROUTES.cms.byId)
  @Permissions('cms:update')
  @RateLimit.Admin()
  @ApiOperation({ summary: 'Update CMS page' })
  updatePage(@Param('id') id: string, @Body() dto: UpdatePageAdminDto) {
    return this.service.updatePage(id, dto);
  }

  /**
   * Soft-delete a CMS page.
   */
  @Delete(ADMIN_API_ROUTES.cms.byId)
  @Permissions('cms:delete')
  @RateLimit.Admin()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete CMS page' })
  deletePage(@Param('id') id: string) {
    return this.service.deletePage(id);
  }
}
