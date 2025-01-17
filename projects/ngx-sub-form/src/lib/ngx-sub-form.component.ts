import { OnDestroy } from '@angular/core';
import {
  AbstractControl,
  AbstractControlOptions,
  ControlValueAccessor,
  FormGroup,
  ValidationErrors,
  Validator,
} from '@angular/forms';
import { merge, Observable, Subscription } from 'rxjs';
import { delay, filter, map, startWith, withLatestFrom } from 'rxjs/operators';
import {
  ControlMap,
  Controls,
  ControlsNames,
  FormUpdate,
  MissingFormControlsError,
  ArrayNotTransformedBeforeWriteValueError,
  FormErrors,
  isNullOrUndefined,
} from './ngx-sub-form-utils';
import { FormGroupOptions, OnFormUpdate, TypedFormGroup } from './ngx-sub-form.types';
import { resetFakeAsyncZone } from '@angular/core/testing';

type MapControlFunction<FormInterface, MapValue> = (ctrl: AbstractControl, key: keyof FormInterface) => MapValue;
type FilterControlFunction<FormInterface> = (ctrl: AbstractControl, key: keyof FormInterface) => boolean;

export abstract class NgxSubFormComponent<ControlInterface, FormInterface = ControlInterface>
  implements ControlValueAccessor, Validator, OnDestroy, OnFormUpdate<FormInterface> {
  public get formGroupControls(): ControlMap<FormInterface, AbstractControl> {
    // @note form-group-undefined we need the no-null-assertion here because we do not want to expose the fact that
    // the form can be undefined, it's handled internally to contain an Angular bug
    // tslint:disable-next-line:no-non-null-assertion
    return this.mapControls<AbstractControl>()!;
  }

  public get formGroupValues(): Required<FormInterface> {
    // see @note form-group-undefined for non-null assertion reason
    // tslint:disable-next-line:no-non-null-assertion
    return this.mapControls(ctrl => ctrl.value)!;
  }

  public get formGroupErrors(): FormErrors<FormInterface> {
    const errors: Partial<
      ControlMap<FormInterface, ValidationErrors | null>
    > | null = this.mapControls<ValidationErrors | null>(ctrl => ctrl.errors, ctrl => ctrl.invalid);

    if (!this.formGroup.errors && (!errors || !Object.keys(errors).length)) {
      return null;
    }

    return Object.assign({}, this.formGroup.errors ? { formGroup: this.formGroup.errors } : {}, errors);
  }

  public get formControlNames(): ControlsNames<FormInterface> {
    // see @note form-group-undefined for as syntax
    return this.mapControls((_, key) => key) as ControlsNames<FormInterface>;
  }

  private controlKeys: (keyof FormInterface)[] = [];

  // when developing the lib it's a good idea to set the formGroup type
  // to current + `| undefined` to catch a bunch of possible issues
  // see @note form-group-undefined
  public formGroup: TypedFormGroup<FormInterface> = (new FormGroup(
    this._getFormControls(),
    this.getFormGroupControlOptions() as AbstractControlOptions,
  ) as unknown) as TypedFormGroup<FormInterface>;

  protected onChange: Function | undefined = undefined;
  protected onTouched: Function | undefined = undefined;
  protected emitNullOnDestroy = true;
  protected emitInitialValueOnInit = true;

  private subscription: Subscription | undefined = undefined;

  constructor() {
    // `setTimeout` and `updateValueAndValidity` are both required here
    // indeed, if you check the demo you'll notice that without it, if
    // you select `Droid` and `Assassin` for example the displayed errors
    // are not yet defined for the field `assassinDroid`
    // (until you change one of the value in that form)
    setTimeout(() => {
      if (this.formGroup) {
        this.formGroup.updateValueAndValidity({ emitEvent: false });
      }
    }, 0);
  }

  // can't define them directly
  protected abstract getFormControls(): Controls<FormInterface>;
  private _getFormControls(): Controls<FormInterface> {
    const controls: Controls<FormInterface> = this.getFormControls();

    this.controlKeys = (Object.keys(controls) as unknown) as (keyof FormInterface)[];

    return controls;
  }

  private mapControls<MapValue>(
    mapControl: MapControlFunction<FormInterface, MapValue>,
    filterControl: FilterControlFunction<FormInterface>,
  ): Partial<ControlMap<FormInterface, MapValue>> | null;
  private mapControls<MapValue>(
    mapControl?: MapControlFunction<FormInterface, MapValue>,
  ): ControlMap<FormInterface, MapValue> | null;
  private mapControls<MapValue>(
    mapControl?: MapControlFunction<FormInterface, MapValue>,
    filterControl: FilterControlFunction<FormInterface> = () => true,
  ): Partial<ControlMap<FormInterface, MapValue>> | null {
    if (!this.formGroup) {
      return null;
    }

    const formControls: Controls<FormInterface> = this.formGroup.controls;

    if (!mapControl) {
      return formControls as any;
    }

    const controls: Partial<ControlMap<FormInterface, MapValue>> = {};

    for (const key in formControls) {
      if (this.formGroup.controls.hasOwnProperty(key)) {
        const control = formControls[key];
        if (control && filterControl(control, key)) {
          controls[key] = mapControl(control, key);
        }
      }
    }

    return controls;
  }

  public onFormUpdate(formUpdate: FormUpdate<FormInterface>): void {}

  /**
   * Extend this method to provide custom local FormGroup level validation
   */
  protected getFormGroupControlOptions(): FormGroupOptions<FormInterface> {
    return {};
  }

  public validate(): ValidationErrors | null {
    if (
      // @hack see where defining this.formGroup to undefined
      !this.formGroup ||
      this.formGroup.valid
    ) {
      return null;
    }

    return this.formGroupErrors;
  }

  // @todo could this be removed to avoid an override and just use `takeUntilDestroyed`?
  public ngOnDestroy(): void {
    // @hack there's a memory leak within Angular and those components
    // are not correctly cleaned up which leads to error if a form is defined
    // with validators and then it's been removed, the validator would still fail
    // `as any` if because we do not want to define the formGroup as FormGroup | undefined
    // everything related to undefined is handled internally and shouldn't be exposed to end user
    (this.formGroup as any) = undefined;

    if (this.subscription) {
      this.subscription.unsubscribe();
    }

    if (this.emitNullOnDestroy && this.onChange) {
      this.onChange(null);
    }

    this.onChange = undefined;
  }

  public writeValue(obj: Required<ControlInterface> | null): void {
    // @hack see where defining this.formGroup to undefined

    if (!this.formGroup) {
      return;
    }

    // should accept falsy values like `false` or empty string
    // if the value is null or undefined it might be because we're
    // switching from one value of a polymorphic type to another
    // for ex and in that case we don't want to go further
    if (obj === undefined) {
      return;
    }

    // if a sub-form receives null we can say that the parent form has called FormGroup.reset().
    // A sub-forms value is expected to be an object of at least one control e.g { mySubFormControl: value } because it generates a FormGroup.
    if (obj === null) {

      // Could we still have a "if ( resetIsReallyWanted )" check. Not sure yet how to make this.
      this.formGroup.reset();

      return;
    }



    const transformedValue: FormInterface = this.transformToFormGroup(obj);

    // for now we throw an error if the transformed value isn't an object with all the expect values
    // there's an issue to track support for an array https://github.com/cloudnc/ngx-sub-form/issues/9
    if (Array.isArray(transformedValue)) {
      throw new ArrayNotTransformedBeforeWriteValueError();
    }

    const missingKeys: (keyof FormInterface)[] = this.getMissingKeys(transformedValue);
    if (missingKeys.length > 0) {
      throw new MissingFormControlsError(missingKeys as string[]);
    }

    this.formGroup.setValue(transformedValue, {
      emitEvent: false,
    });
    this.formGroup.markAsPristine();
    this.formGroup.markAsUntouched();
  }

  private getMissingKeys(transformedValue: FormInterface | null) {
    // `controlKeys` can be an empty array, empty forms are allowed
    const missingKeys: (keyof FormInterface)[] = this.controlKeys.reduce(
      (keys, key) => {
        if (isNullOrUndefined(transformedValue) || transformedValue[key] === undefined) {
          keys.push(key);
        }

        return keys;
      },
      [] as (keyof FormInterface)[],
    );

    return missingKeys;
  }

  // when customizing the emission rate of your sub form component, remember not to **mutate** the stream
  // it is safe to throttle, debounce, delay, etc but using skip, first, last or mutating data inside
  // the stream will cause issues!
  protected handleEmissionRate(): (obs$: Observable<FormInterface>) => Observable<FormInterface> {
    return obs$ => obs$;
  }

  // that method can be overridden if the
  // shape of the form needs to be modified
  protected transformToFormGroup(obj: ControlInterface): FormInterface {
    return (obj as any) as FormInterface;
  }

  // that method can be overridden if the
  // shape of the form needs to be modified
  protected transformFromFormGroup(formValue: FormInterface): ControlInterface | null {
    return (formValue as any) as ControlInterface;
  }

  public registerOnChange(fn: (_: any) => void): void {
    if (!this.formGroup) {
      return;
    }

    this.onChange = fn;

    interface KeyValueForm {
      key: keyof FormInterface;
      value: unknown;
    }

    const formControlNames: (keyof FormInterface)[] = Object.keys(this.formControlNames) as (keyof FormInterface)[];

    const formValues: Observable<KeyValueForm>[] = formControlNames.map(key =>
      this.formGroup.controls[key].valueChanges.pipe(
        startWith(this.formGroup.controls[key].value),
        map(value => ({ key, value })),
      ),
    );

    const lastKeyEmitted$: Observable<keyof FormInterface> = merge(...formValues.map(obs => obs.pipe(map(x => x.key))));

    this.subscription = this.formGroup.valueChanges
      .pipe(
        // hook to give access to the observable for sub-classes
        // this allow sub-classes (for example) to debounce, throttle, etc
        this.handleEmissionRate(),
        startWith(this.formGroup.value),
        // this is required otherwise an `ExpressionChangedAfterItHasBeenCheckedError` will happen
        // this is due to the fact that parent component will define a given state for the form that might
        // be changed once the children are being initialized
        delay(0),
        filter(() => !!this.formGroup),
        // detect which stream emitted last
        withLatestFrom(lastKeyEmitted$),
        map(([changes, keyLastEmit], index) => {
          if (index > 0 && this.onTouched) {
            this.onTouched();
          }

          if (index > 0 || (index === 0 && this.emitInitialValueOnInit)) {
            if (this.onChange) {
              this.onChange(this.transformFromFormGroup(changes));
            }

            const formUpdate: FormUpdate<FormInterface> = {};
            formUpdate[keyLastEmit] = true;
            this.onFormUpdate(formUpdate);
          }
        }),
      )
      .subscribe();
  }

  public registerOnTouched(fn: any): void {
    this.onTouched = fn;
  }

  public setDisabledState(shouldDisable: boolean | undefined): void {
    if (!this.formGroup) {
      return;
    }

    if (shouldDisable) {
      this.formGroup.disable({ emitEvent: false });
    } else {
      this.formGroup.enable({ emitEvent: false });
    }
  }
}

export abstract class NgxSubFormRemapComponent<ControlInterface, FormInterface> extends NgxSubFormComponent<
  ControlInterface,
  FormInterface
> {
  protected abstract transformToFormGroup(obj: ControlInterface | null): FormInterface;
  protected abstract transformFromFormGroup(formValue: FormInterface): ControlInterface | null;
}
