import { IsDefined, IsInt, IsOptional, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { TranslatableDto } from './translatable.dto';

export class CreateProductFaqAdminDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => TranslatableDto)
  question: TranslatableDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => TranslatableDto)
  answer: TranslatableDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
